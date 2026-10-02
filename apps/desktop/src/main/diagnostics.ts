import { rm } from "node:fs/promises";
import * as NodePath from "node:path";

import type * as SentryMain from "@sentry/electron/main";

import type { DiagnosticsConsent, Outcome } from "../shared/api.ts";
import {
  HELPER_EXIT_MESSAGE,
  SESSION_MEASUREMENTS,
  SESSION_TRANSACTION,
  scrubEvent,
  scrubLogs,
  type DiagnosticLog,
  type HelperTag,
  type LogLevel,
  type SessionAttribute,
} from "./diagnostics-scrub.ts";
import type { SessionReport } from "./dictation.ts";
import type { HelperExit } from "./helper.ts";

type NodeOptions = SentryMain.NodeOptions;
type MakeTransport = NonNullable<NodeOptions["transport"]>;
type Envelope = Parameters<ReturnType<MakeTransport>["send"]>[0];
type EnvelopeItem = Envelope[1][number];

// Production loads @sentry/electron/main; tests pass @sentry/node, which shares the same client.
export type DiagnosticsSdk = Pick<
  typeof SentryMain,
  "startInactiveSpan" | "setMeasurement" | "captureMessage" | "logger" | "withActiveSpan" | "flush"
> & { init(options: NodeOptions): unknown; makeTransport: MakeTransport };

export type Diagnostics = {
  active: boolean;
  sessionDone(report: SessionReport): void;
  helperExited(exit: HelperExit): void;
  log(entry: DiagnosticLog): void;
  flush(timeoutMs: number): Promise<void>;
};

// Everything else the SDK enables by default collects context (breadcrumbs, console, network,
// screenshots, device and locale details, local variables) that Voice never sends.
const INTEGRATIONS: ReadonlySet<string> = new Set([
  "SentryMinidump",
  "OnUncaughtException",
  "OnUnhandledRejection",
  "EventFilters",
  "FunctionToString",
  "LinkedErrors",
  "NormalizePaths",
]);

const off: Diagnostics = {
  active: false,
  sessionDone() {},
  helperExited() {},
  log() {},
  flush: async () => {},
};

const SESSION_LEVELS: Record<Outcome["kind"], LogLevel> = {
  inserted: "info",
  empty: "warn",
  tooShort: "warn",
  notInserted: "warn",
  failed: "error",
};

async function removeCrashDumps(dir: string) {
  await Promise.allSettled(
    ["completed", "pending"].map((name) =>
      rm(NodePath.join(dir, name), { recursive: true, force: true }),
    ),
  );
}

// Model ids are left out: each release pins its models, so the release already names them.
export function sessionSpan({ outcome, finishedAt, capture }: SessionReport) {
  const attributes: { [K in SessionAttribute]?: string | undefined } = {
    outcome: outcome.kind,
    "insert.method": outcome.kind === "inserted" ? outcome.method : undefined,
    "insert.reason": outcome.kind === "notInserted" ? outcome.reason : undefined,
    "dictation.language": capture?.language,
  };
  const measurements: Partial<Record<(typeof SESSION_MEASUREMENTS)[number], number>> = {};
  for (const name of SESSION_MEASUREMENTS) {
    const value = capture?.timings[name];
    if (value !== undefined) measurements[name] = value;
  }
  return {
    name: SESSION_TRANSACTION,
    op: SESSION_TRANSACTION,
    startTime: capture?.pressedAt ?? finishedAt,
    endTime: finishedAt,
    attributes,
    measurements,
  };
}

// Logs bypass scrubEvent and the SDK's beforeSendLog sees neither scope attributes nor renderer
// logs, so every log item is scrubbed here, on its way out. An envelope left empty is not sent.
function scrubLogItems([headers, items]: Envelope): Envelope | undefined {
  const kept: EnvelopeItem[] = [];
  for (const item of items as readonly EnvelopeItem[]) {
    if (item[0].type !== "log") {
      kept.push(item);
      continue;
    }
    const logs = scrubLogs(item[1]);
    if (logs.items.length > 0) kept.push([{ ...item[0], item_count: logs.items.length }, logs]);
  }
  return kept.length > 0 ? ([headers, kept] as Envelope) : undefined;
}

function helperTags(exit: HelperExit): Partial<Record<HelperTag, string | number>> {
  if ("spawnError" in exit) return { "helper.error": exit.spawnError };
  if (exit.signal) return { "helper.signal": exit.signal };
  return { "helper.exit_code": exit.code ?? "none" };
}

export function startDiagnostics(options: {
  loadSdk: () => DiagnosticsSdk;
  dsn: string;
  release: string;
  environment: string;
  tracesSampleRate: number;
  consent: () => DiagnosticsConsent;
  crashDumpsDir: string;
}): Diagnostics {
  const on = () => options.consent() === "on";
  // Turning consent on takes effect at the next launch: the SDK can only start before ready.
  // Dumps written while sharing was on must not be uploaded after a later opt-out and opt-in,
  // so any left over are removed whenever the SDK does not start.
  if (options.dsn === "" || !on()) {
    void removeCrashDumps(options.crashDumpsDir);
    return off;
  }

  const sdk = options.loadSdk();
  sdk.init({
    dsn: options.dsn,
    release: options.release,
    environment: options.environment,
    sendDefaultPii: false,
    sendClientReports: false,
    tracePropagationTargets: [],
    tracesSampleRate: options.tracesSampleRate,
    enableLogs: true,
    beforeSend: (event, hint) => {
      // Attachments are raw bytes the scrubber cannot read. A native crash dump holds whole
      // thread stacks, which include the process environment (HOME, USER, PATH), so the crash
      // event is sent without its dump.
      hint.attachments = [];
      return { ...scrubEvent(event), type: undefined };
    },
    beforeSendTransaction: (event) => ({ ...scrubEvent(event), type: "transaction" }),
    // Turning consent off stops sending at once, including events the SDK's own integrations capture.
    transport: (transportOptions) => {
      const base = sdk.makeTransport(transportOptions);
      return {
        ...base,
        send: (envelope) => {
          const scrubbed = on() ? scrubLogItems(envelope) : undefined;
          return scrubbed ? base.send(scrubbed) : Promise.resolve({});
        },
      };
    },
    integrations: (defaults) => defaults.filter(({ name }) => INTEGRATIONS.has(name)),
  });

  function log(entry: DiagnosticLog) {
    // The SDK would send an undefined attribute as an empty string.
    const attributes = Object.fromEntries(
      Object.entries("attributes" in entry ? (entry.attributes ?? {}) : {}).filter(
        ([, value]) => value !== undefined,
      ),
    );
    sdk.logger[entry.level](entry.message, attributes);
  }

  const reportedExits = new Set<string>();
  return {
    active: true,
    sessionDone(report) {
      const { attributes, measurements, endTime, ...start } = sessionSpan(report);
      const span = sdk.startInactiveSpan({ ...start, attributes, forceTransaction: true });
      for (const [name, value] of Object.entries(measurements)) {
        sdk.setMeasurement(name, value, "millisecond", span);
      }
      // Logs are not sampled, so every session is counted even when its transaction is not sent.
      sdk.withActiveSpan(span, () =>
        log({
          message: "dictation session finished",
          level: SESSION_LEVELS[report.outcome.kind],
          attributes: { ...attributes, ...measurements },
        }),
      );
      span.end(endTime);
    },
    helperExited(exit) {
      const tags = helperTags(exit);
      log({ message: "helper exited", level: "error", attributes: tags });
      // A helper that keeps failing restarts every few seconds; one report per kind is enough.
      const key = JSON.stringify(tags);
      if (reportedExits.has(key)) return;
      reportedExits.add(key);
      sdk.captureMessage(HELPER_EXIT_MESSAGE, { level: "error", tags });
    },
    log,
    flush: async (timeoutMs) => {
      await sdk.flush(timeoutMs);
    },
  };
}

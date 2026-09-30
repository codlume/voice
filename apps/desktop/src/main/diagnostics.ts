import { rm } from "node:fs/promises";
import * as NodePath from "node:path";

import type * as SentryMain from "@sentry/electron/main";

import type { DiagnosticsConsent } from "../shared/api.ts";
import {
  HELPER_EXIT_MESSAGE,
  SESSION_MEASUREMENTS,
  SESSION_TRANSACTION,
  scrubEvent,
  type HelperTag,
  type SessionAttribute,
} from "./diagnostics-scrub.ts";
import type { SessionReport } from "./dictation.ts";
import type { HelperExit } from "./helper.ts";

type NodeOptions = SentryMain.NodeOptions;
type MakeTransport = NonNullable<NodeOptions["transport"]>;

// Production loads @sentry/electron/main; tests pass @sentry/node, which shares the same client.
export type DiagnosticsSdk = Pick<
  typeof SentryMain,
  "startInactiveSpan" | "setMeasurement" | "captureMessage"
> & { init(options: NodeOptions): unknown; makeTransport: MakeTransport };

export type Diagnostics = {
  active: boolean;
  sessionDone(report: SessionReport): void;
  helperExited(exit: HelperExit): void;
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

const off: Diagnostics = { active: false, sessionDone() {}, helperExited() {} };

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
      return { ...base, send: (envelope) => (on() ? base.send(envelope) : Promise.resolve({})) };
    },
    integrations: (defaults) => defaults.filter(({ name }) => INTEGRATIONS.has(name)),
  });

  const reportedExits = new Set<string>();
  return {
    active: true,
    sessionDone(report) {
      const { measurements, endTime, ...start } = sessionSpan(report);
      const span = sdk.startInactiveSpan({ ...start, forceTransaction: true });
      for (const [name, value] of Object.entries(measurements)) {
        sdk.setMeasurement(name, value, "millisecond", span);
      }
      span.end(endTime);
    },
    helperExited(exit) {
      const tags = helperTags(exit);
      // A helper that keeps failing restarts every few seconds; one report per kind is enough.
      const key = JSON.stringify(tags);
      if (reportedExits.has(key)) return;
      reportedExits.add(key);
      sdk.captureMessage(HELPER_EXIT_MESSAGE, { level: "error", tags });
    },
  };
}

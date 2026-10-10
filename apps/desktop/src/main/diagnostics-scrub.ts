import type { Event, Exception, NodeOptions, StackFrame } from "@sentry/electron/main";

import type { SessionTimings } from "./dictation.ts";

export type Envelope = Parameters<ReturnType<NonNullable<NodeOptions["transport"]>>["send"]>[0];
type EnvelopeItem = Envelope[1][number];
type EventItem = [{ type: "event" | "transaction" }, Event];

export const HELPER_EXIT_MESSAGE = "Voice helper exited unexpectedly";
export const SESSION_TRANSACTION = "dictation.session";
export const SESSION_ATTRIBUTES = [
  "outcome",
  "insert.method",
  "insert.reason",
  "dictation.language",
] as const;
export type SessionAttribute = (typeof SESSION_ATTRIBUTES)[number];
export const HELPER_TAGS = ["helper.exit_code", "helper.signal", "helper.error"] as const;
export type HelperTag = (typeof HELPER_TAGS)[number];
export const SESSION_MEASUREMENTS = [
  "startMs",
  "audioMs",
  "asrMs",
  "cleanupMs",
  "insertMs",
  "releaseToInsertMs",
] as const satisfies readonly (keyof SessionTimings)[];

// Helper log lines that carry no parameters. Any other helper line stays on this machine.
export const HELPER_LOGS = [
  "could not monitor microphone changes",
  "clipboard changed during paste; not restoring previous contents",
  "asr.remove ignored while the speech model downloads",
  "asr.remove ignored while the speech model loads",
  "streaming ASR incomplete; retrying complete capture",
  "hotkey tap unavailable: CGEvent.tapCreate returned nil",
  "hotkey tap unavailable: accessibility not granted",
  "hotkey tap installed",
] as const;
type HelperLog = (typeof HELPER_LOGS)[number];

// The only log messages that leave the machine, each with the attributes it may carry.
export const LOGS = {
  "dictation session finished": [...SESSION_ATTRIBUTES, ...SESSION_MEASUREMENTS],
  "helper ready": ["helper.protocol_version"],
  "helper protocol mismatch": ["helper.protocol_version", "helper.expected_version"],
  "helper exited": HELPER_TAGS,
  "helper event unparseable": [],
  "helper stdin failed": ["error.code"],
  "helper command dropped": ["command.type"],
  "cleanup failed": ["error.type"],
  "cleanup timed out": ["cleanup.budget_ms"],
  "shutdown overran": ["shutdown.timeout_ms"],
  "dock update failed": [],
  "account sign-in failed": ["error.type", "account.failure"],
  "account sign-in timed out": [],
  "account restore failed": ["error.type"],
  "account auth session check failed": ["error.type", "http.response.status_code"],
  "account auth session ended": ["http.response.status_code"],
  "account server sign-out queue discarded": [],
  "account server sign-out failed": ["error.type", "http.response.status_code"],
  "account deletion failed": ["error.type"],
  "account auth session revocation failed": ["error.type"],
} as const satisfies Record<string, readonly string[]>;
type AppLog = keyof typeof LOGS;

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

type LogMessage = AppLog | HelperLog;
type LogAttributeKey<N extends LogMessage> = N extends AppLog ? (typeof LOGS)[N][number] : never;

export type DiagnosticLog = {
  [N in LogMessage]: {
    message: N;
    level: LogLevel;
    attributes?: { [K in LogAttributeKey<N>]?: string | number | boolean | undefined };
  };
}[LogMessage];

// Every message is printed locally; only an entry, when given, may leave the machine.
export type Log = (message: string, entry?: DiagnosticLog) => void;

const HELPER_LOG_MESSAGES: ReadonlySet<string> = new Set(HELPER_LOGS);
export const isHelperLog = (message: string): message is HelperLog =>
  HELPER_LOG_MESSAGES.has(message);

// An error name is code, not data, unless something rewrote it into free text.
export const errorType = (error: unknown) =>
  error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";

const MESSAGES: ReadonlySet<string> = new Set([HELPER_EXIT_MESSAGE]);
const TAGS: ReadonlySet<string> = new Set([
  ...SESSION_ATTRIBUTES,
  ...HELPER_TAGS,
  // Set by @sentry/electron on renderer, minidump, and child-process events.
  "event.process",
  "event.environment",
  "exit.reason",
]);
const TRACE_DATA: ReadonlySet<string> = new Set([
  ...SESSION_ATTRIBUTES,
  "sentry.origin",
  "sentry.op",
  "sentry.source",
  "sentry.sample_rate",
]);
const MEASUREMENTS: ReadonlySet<string> = new Set(SESSION_MEASUREMENTS);

type Primitive = string | number | boolean;

const HOME = /([/\\])Users\1[^/\\]+/g;
const redact = (value: string) => value.replace(HOME, "$1Users$1<redacted>");

const text = (value: unknown) => (typeof value === "string" ? redact(value) : undefined);
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const boolean = (value: unknown) => (typeof value === "boolean" ? value : undefined);
const primitive = (value: unknown): Primitive | undefined =>
  text(value) ?? number(value) ?? boolean(value);

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type Loose<T> = { [K in keyof T]?: T[K] | undefined };

// Keeps undefined out of the result so the scrubbed event holds only what was allowed.
function compact<T extends object>(value: Loose<T>): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function allowed(value: unknown, keys: ReadonlySet<string>): Record<string, Primitive> {
  const kept: Record<string, Primitive> = {};
  for (const [key, entry] of Object.entries(record(value))) {
    const clean = keys.has(key) ? primitive(entry) : undefined;
    if (clean !== undefined) kept[key] = clean;
  }
  return kept;
}

function frame(value: StackFrame): StackFrame {
  return compact<StackFrame>({
    filename: text(value.filename),
    abs_path: text(value.abs_path),
    function: text(value.function),
    module: text(value.module),
    lineno: number(value.lineno),
    colno: number(value.colno),
    in_app: boolean(value.in_app),
    instruction_addr: text(value.instruction_addr),
    platform: text(value.platform),
  });
}

// The exception value is dropped: an error message can quote whatever the code was handling.
function exception(value: Exception): Exception {
  const mechanism = value.mechanism;
  const frames = value.stacktrace?.frames;
  return compact<Exception>({
    type: text(value.type),
    mechanism:
      mechanism && typeof mechanism.type === "string"
        ? compact<typeof mechanism>({
            type: redact(mechanism.type),
            handled: boolean(mechanism.handled),
          })
        : undefined,
    stacktrace: Array.isArray(frames) ? { frames: frames.map(frame) } : undefined,
  });
}

type DebugImage = NonNullable<NonNullable<Event["debug_meta"]>["images"]>[number];

// JavaScript source maps resolve through sourcemap images, and crash events carry no dump to
// symbolicate, so no other kind is kept.
function sourceMapImages(images: readonly DebugImage[]): DebugImage[] {
  return images.flatMap((image) =>
    image.type === "sourcemap" &&
    typeof image.code_file === "string" &&
    typeof image.debug_id === "string"
      ? [{ type: "sourcemap", code_file: redact(image.code_file), debug_id: image.debug_id }]
      : [],
  );
}

type TraceContext = NonNullable<NonNullable<Event["contexts"]>["trace"]>;

function trace(value: unknown): TraceContext | undefined {
  const context = record(value);
  if (typeof context.trace_id !== "string" || typeof context.span_id !== "string") return;
  return compact<TraceContext>({
    trace_id: context.trace_id,
    span_id: context.span_id,
    parent_span_id: text(context.parent_span_id),
    op: text(context.op),
    status: text(context.status),
    origin: text(context.origin) as TraceContext["origin"],
    data: allowed(context.data, TRACE_DATA),
  });
}

function measurements(value: Event["measurements"]): Event["measurements"] {
  const kept: NonNullable<Event["measurements"]> = {};
  for (const [name, measurement] of Object.entries(value ?? {})) {
    const clean = number(measurement.value);
    if (MEASUREMENTS.has(name) && clean !== undefined) {
      kept[name] = { value: clean, unit: "millisecond" };
    }
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

export function scrubEvent(event: Event): Event {
  const exceptions = event.exception?.values;
  const images = event.debug_meta?.images;
  const traceContext = trace(event.contexts?.trace);
  const tags = allowed(event.tags, TAGS);
  return compact<Event>({
    event_id: text(event.event_id),
    timestamp: number(event.timestamp),
    start_timestamp: number(event.start_timestamp),
    type: event.type === "transaction" ? "transaction" : undefined,
    platform: text(event.platform),
    level: event.level,
    release: text(event.release),
    environment: text(event.environment),
    sdk:
      event.sdk &&
      compact<NonNullable<Event["sdk"]>>({
        name: text(event.sdk.name),
        version: text(event.sdk.version),
      }),
    message:
      typeof event.message === "string" && MESSAGES.has(event.message) ? event.message : undefined,
    exception: Array.isArray(exceptions) ? { values: exceptions.map(exception) } : undefined,
    debug_meta: Array.isArray(images) ? { images: sourceMapImages(images) } : undefined,
    tags: Object.keys(tags).length > 0 ? tags : undefined,
    contexts: traceContext ? { trace: traceContext } : undefined,
    transaction: event.transaction === SESSION_TRANSACTION ? SESSION_TRANSACTION : undefined,
    measurements: measurements(event.measurements),
  });
}

// Describe the build, not the machine or the user. Everything else the SDK attaches to a log
// (user, host, OS, device, process, message template and parameters) is dropped.
const LOG_SDK_ATTRIBUTES: ReadonlySet<string> = new Set([
  "sentry.release",
  "sentry.environment",
  "sentry.sdk.name",
  "sentry.sdk.version",
  "sentry.timestamp.sequence",
]);
const LEVELS: ReadonlySet<string> = new Set(LOG_LEVELS);
const LOG_ATTRIBUTES: ReadonlyMap<string, readonly string[]> = new Map([
  ...Object.entries(LOGS),
  ...HELPER_LOGS.map((message) => [message, []] as const),
]);

type LogAttribute =
  | { value: string; type: "string" }
  | { value: number; type: "integer" | "double" }
  | { value: boolean; type: "boolean" };

type ScrubbedLog = {
  timestamp: number;
  level: LogLevel;
  body: string;
  trace_id?: string;
  severity_number?: number;
  attributes: Record<string, LogAttribute>;
};

const isLevel = (value: unknown): value is LogLevel =>
  typeof value === "string" && LEVELS.has(value);

function logAttribute(value: unknown): LogAttribute | undefined {
  const { value: raw, type } = record(value);
  if (type === "string" && typeof raw === "string") return { value: redact(raw), type };
  const finite = number(raw);
  if ((type === "integer" || type === "double") && finite !== undefined)
    return { value: finite, type };
  if (type === "boolean" && typeof raw === "boolean") return { value: raw, type };
}

function logAttributes(value: unknown, keys: readonly string[]): Record<string, LogAttribute> {
  const kept: Record<string, LogAttribute> = {};
  for (const [key, entry] of Object.entries(record(value))) {
    const clean =
      keys.includes(key) || LOG_SDK_ATTRIBUTES.has(key) ? logAttribute(entry) : undefined;
    if (clean !== undefined) kept[key] = clean;
  }
  return kept;
}

function log(value: unknown): ScrubbedLog | undefined {
  const { body, level, ...item } = record(value);
  if (typeof body !== "string") return;
  const keys = LOG_ATTRIBUTES.get(body);
  const timestamp = number(item.timestamp);
  if (keys === undefined || !isLevel(level) || timestamp === undefined) return;
  return compact<ScrubbedLog>({
    timestamp,
    level,
    body,
    trace_id: text(item.trace_id),
    severity_number: number(item.severity_number),
    attributes: logAttributes(item.attributes, keys),
  });
}

export function scrubLogs(payload: unknown): { version?: number; items: ScrubbedLog[] } {
  const { version, items } = record(payload);
  return compact({
    version: number(version),
    items: Array.isArray(items) ? items.flatMap((item) => log(item) ?? []) : [],
  });
}

const EVENT_ID = /^[0-9a-f]{32}$/;
const SENT_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SDK_NAME = /^sentry\.javascript\.[a-z]+$/;
const SDK_VERSION = /^\d+\.\d+\.\d+$/;
const LOG_CONTENT_TYPE = "application/vnd.sentry.items.log+json";

const matching = (value: unknown, pattern: RegExp) =>
  typeof value === "string" && pattern.test(value) ? value : undefined;

// The trace header (the dynamic sampling context) is dropped. Main copies a renderer envelope's
// trace header onto the event it captures, so it would carry whatever the renderer wrote.
function envelopeHeaders(value: unknown) {
  const { event_id, sent_at, sdk } = record(value);
  const name = matching(record(sdk).name, SDK_NAME);
  const version = matching(record(sdk).version, SDK_VERSION);
  return compact<{ event_id?: string; sent_at?: string; sdk?: { name: string; version: string } }>({
    event_id: matching(event_id, EVENT_ID),
    sent_at: matching(sent_at, SENT_AT),
    sdk: name && version ? { name, version } : undefined,
  });
}

const isEventItem = (item: EnvelopeItem): item is EventItem =>
  item[0].type === "event" || item[0].type === "transaction";

// Attachments are raw bytes the scrubber cannot read, and a native crash dump holds whole thread
// stacks, including the process environment (HOME, USER, PATH), so a crash event is sent without
// its dump.
export function scrubEnvelope([headers, items]: Envelope): Envelope | undefined {
  const kept: EnvelopeItem[] = [];
  for (const item of items) {
    if (isEventItem(item)) {
      kept.push([{ type: item[0].type }, scrubEvent(item[1])]);
    } else if (item[0].type === "log") {
      const logs = scrubLogs(item[1]);
      if (logs.items.length === 0) continue;
      kept.push([
        { type: "log", item_count: logs.items.length, content_type: LOG_CONTENT_TYPE },
        logs,
      ]);
    }
  }
  return kept.length > 0 ? ([envelopeHeaders(headers), kept] as Envelope) : undefined;
}

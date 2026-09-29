import type { Event, Exception, StackFrame } from "@sentry/electron/main";

import type { SessionTimings } from "./dictation.ts";

// Every diagnostic leaves the machine through scrubEvent. It copies only the fields listed here
// into a new event, so anything the SDK or a future integration adds is dropped by default.

export const HELPER_EXIT_MESSAGE = "Voice helper exited unexpectedly";
export const SESSION_TRANSACTION = "dictation.session";
export const SESSION_ATTRIBUTES = [
  "outcome",
  "insert.method",
  "insert.reason",
  "dictation.language",
] as const;
export const SESSION_MEASUREMENTS = [
  "startMs",
  "audioMs",
  "asrMs",
  "cleanupMs",
  "insertMs",
  "releaseToInsertMs",
] as const satisfies readonly (keyof SessionTimings)[];

const MESSAGES: ReadonlySet<string> = new Set([HELPER_EXIT_MESSAGE]);
const TAGS: ReadonlySet<string> = new Set([
  ...SESSION_ATTRIBUTES,
  "helper.exit_code",
  "helper.signal",
  "helper.error",
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
    type: event.type,
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

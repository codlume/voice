import { Schema } from "effect";
const identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));
const count = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(4_800_000),
);
export const attempt = { session: identity, attempt: identity };
export type Attempt = { readonly session: string; readonly attempt: string };
export const SessionCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["session.start", "session.stop", "session.cancel", "app.quit.cancel"]),
  }),
  Schema.Struct({
    type: Schema.Literals(["recovery.copy", "recovery.discard", "practice.delivered"]),
    id: identity,
  }),
]);
export type SessionCommand = typeof SessionCommand.Type;
export const RecoveryEntry = Schema.Struct({
  id: identity,
  text: Schema.String,
  transcription: Schema.Literals(["complete", "incomplete"]),
  hasAudio: Schema.Boolean,
  cause: Schema.String,
  delivery: Schema.Literals(["undelivered", "copied", "failed", "uncertain"]),
});
export type RecoveryEntry = typeof RecoveryEntry.Type;
export const SessionSnapshot = Schema.Struct({
  phase: Schema.Literals([
    "idle",
    "starting",
    "recording",
    "processing",
    "complete",
    "cancelled",
    "failed",
  ]),
  canStart: Schema.Boolean,
  warning: Schema.Boolean,
  message: Schema.String,
  practiceText: Schema.String,
  recovery: Schema.Array(RecoveryEntry),
  recoveryMessage: Schema.String,
  quitWarning: Schema.Boolean,
  pendingPractice: Schema.NullOr(identity),
  latestSuccessful: Schema.NullOr(Schema.Struct({ id: identity, text: Schema.String })),
});
export type SessionSnapshot = typeof SessionSnapshot.Type;
export const CaptureCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("capture.start"),
    ...attempt,
    device: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("capture.stop"), ...attempt }),
  Schema.Struct({ type: Schema.Literal("capture.cancel"), ...attempt }),
]);
export type CaptureCommand = typeof CaptureCommand.Type;
export const CaptureEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("capture.frame"),
    ...attempt,
    sequence: count,
    pcm: Schema.String.check(
      Schema.isMaxLength(8192),
      Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("capture.stopped"),
    ...attempt,
    frames: count,
    samples: count,
  }),
  Schema.Struct({ type: Schema.Literal("capture.failed"), ...attempt }),
]);
export type CaptureEvent = typeof CaptureEvent.Type;
export const ProviderFailure = Schema.Literals([
  "connection",
  "rejected",
  "quota",
  "rate-limit",
  "incomplete",
  "protocol",
  "worker",
]);
export type ProviderFailure = typeof ProviderFailure.Type;
export const ProviderRequest = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("start"),
    ...attempt,
    key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  }),
  Schema.Struct({
    type: Schema.Literal("audio"),
    ...attempt,
    sequence: count,
    pcm: Schema.Uint8Array,
  }),
  Schema.Struct({ type: Schema.Literal("stop"), ...attempt, frames: count, samples: count }),
  Schema.Struct({ type: Schema.Literal("cancel"), ...attempt }),
]);
export type ProviderRequest = typeof ProviderRequest.Type;
export const ProviderEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("partial"),
    ...attempt,
    text: Schema.String.check(Schema.isMaxLength(100_000)),
  }),
  Schema.Struct({
    type: Schema.Literal("stable"),
    ...attempt,
    text: Schema.String.check(Schema.isMaxLength(100_000)),
  }),
  Schema.Struct({
    type: Schema.Literal("complete"),
    ...attempt,
    text: Schema.String.check(Schema.isMaxLength(100_000)),
    samples: count,
  }),
  Schema.Struct({ type: Schema.Literal("failed"), ...attempt, reason: ProviderFailure }),
]);
export type ProviderEvent = typeof ProviderEvent.Type;
const strict = { onExcessProperty: "error" } as const;
export const decodeCaptureCommand = Schema.decodeUnknownSync(CaptureCommand, strict);
export const decodeCaptureEvent = Schema.decodeUnknownSync(CaptureEvent, strict);
export const decodeProviderRequest = Schema.decodeUnknownSync(ProviderRequest, strict);
export const decodeProviderEvent = Schema.decodeUnknownSync(ProviderEvent, strict);

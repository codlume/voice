import { Schema } from "effect";
const identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));
const count = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(4_800_000),
);
export const attempt = { session: identity, attempt: identity };
export type Attempt = { readonly session: string; readonly attempt: string };
// Practice delivers to Voice's own field; dictation delivers to the external target focused at Start.
export const Origin = Schema.Literals(["practice", "dictation"]);
export type Origin = typeof Origin.Type;
export const SessionCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session.start"), origin: Origin }),
  Schema.Struct({
    type: Schema.Literals(["session.stop", "session.cancel", "app.quit.cancel"]),
  }),
  Schema.Struct({
    type: Schema.Literals([
      "recovery.copy",
      "recovery.discard",
      "recovery.paste",
      "practice.delivered",
    ]),
    id: identity,
  }),
]);
export const sessionCommandTypes = [
  "session.start",
  "session.stop",
  "session.cancel",
  "app.quit.cancel",
  "recovery.copy",
  "recovery.discard",
  "recovery.paste",
  "practice.delivered",
] as const satisfies readonly SessionCommand["type"][];
export type SessionCommand = typeof SessionCommand.Type;
export const RecoveryEntry = Schema.Struct({
  id: identity,
  text: Schema.String,
  transcription: Schema.Literals(["complete", "incomplete"]),
  hasAudio: Schema.Boolean,
  cause: Schema.String,
  delivery: Schema.Literals(["undelivered", "copied", "inserted", "failed", "uncertain"]),
});
export type RecoveryEntry = typeof RecoveryEntry.Type;
// Why Start is unavailable. Every entry point disables Start with this cause and never queues it.
export const StartBlocker = Schema.Literals([
  "busy",
  "paste",
  "recovery-full",
  "setup",
  "quitting",
]);
export type StartBlocker = typeof StartBlocker.Type;
export const startBlockerMessages: Record<StartBlocker, string> = {
  busy: "A session is already in progress.",
  paste: "A paste is waiting for you to choose a field.",
  "recovery-full": "Recovery is full. Resolve or discard a session first.",
  setup: "Complete or repair dictation setup first.",
  quitting: "Voice is quitting.",
};
// The kind of the current session message, so every surface offers the same repair action.
export const Notice = Schema.Literals([
  "limit",
  "connection",
  "no-speech",
  "incomplete",
  "setup",
  "recovery-full",
  "not-inserted",
  "uncertain",
]);
export type Notice = typeof Notice.Type;
export const SessionSnapshot = Schema.Struct({
  phase: Schema.Literals([
    "idle",
    "starting",
    "recording",
    "processing",
    "inserting",
    "complete",
    "cancelled",
    "failed",
  ]),
  origin: Schema.NullOr(Origin),
  armedPaste: Schema.NullOr(identity),
  blocker: Schema.NullOr(StartBlocker),
  notice: Schema.NullOr(Notice),
  message: Schema.String,
  practiceText: Schema.String,
  recovery: Schema.Array(RecoveryEntry),
  recoveryMessage: Schema.String,
  quitWarning: Schema.Boolean,
  pendingPractice: Schema.NullOr(identity),
  latestSuccessful: Schema.NullOr(Schema.Struct({ id: identity, text: Schema.String })),
  // The most recent transcript still held, delivered or not, for Copy/Paste last transcript.
  lastTranscript: Schema.NullOr(identity),
  // Which of `message` and `recoveryMessage` changed most recently, so the floating bar shows
  // the outcome of a menu Copy or Paste rather than an older session message.
  lastUpdate: Schema.Literals(["session", "recovery"]),
});
export type SessionSnapshot = typeof SessionSnapshot.Type;
// Shared by every surface, so Stop and Cancel availability cannot drift between them.
export const isCapturing = ({ phase }: SessionSnapshot) =>
  phase === "starting" || phase === "recording";
export const isCancellable = (session: SessionSnapshot) =>
  isCapturing(session) || session.phase === "processing" || session.armedPaste !== null;
export const isBusy = (session: SessionSnapshot) =>
  isCancellable(session) || session.phase === "inserting";
// Native shortcut transitions after the helper applied the configured bindings.
export const ShortcutAction = Schema.Literals(["hold.down", "hold.up", "toggle", "cancel"]);
export type ShortcutAction = typeof ShortcutAction.Type;
export const ShortcutEvent = Schema.Struct({
  type: Schema.Literal("shortcut"),
  action: ShortcutAction,
});
export type ShortcutEvent = typeof ShortcutEvent.Type;
// Screen points, top-left origin, as reported by Electron and by CGEvent locations.
export const screenCoordinate = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(-100_000),
  Schema.isLessThanOrEqualTo(100_000),
);
// A real click on the floating bar, taken over by the helper's event tap so it never reaches the
// window server and never activates Voice. Coordinates are screen points.
export const BarPointerEvent = Schema.Struct({
  type: Schema.Literal("bar.pointer"),
  phase: Schema.Literals(["down", "up"]),
  x: screenCoordinate,
  y: screenCoordinate,
});
export type BarPointerEvent = typeof BarPointerEvent.Type;
// Eligibility of the external editable target remembered for a session.
export const TargetStatus = Schema.Literals([
  "eligible",
  "none",
  "unsupported",
  "protected",
  "terminal",
  "unavailable",
]);
export type TargetStatus = typeof TargetStatus.Type;
export const InsertionOutcome = Schema.Literals([
  "inserted",
  "changed",
  "closed",
  "protected",
  "unsupported",
  "missing",
  "failed",
  "uncertain",
]);
export type InsertionOutcome = typeof InsertionOutcome.Type;
export const TargetSelected = Schema.Struct({
  type: Schema.Literal("target.selected"),
  session: identity,
  status: TargetStatus,
});
export type TargetSelected = typeof TargetSelected.Type;
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
export const decodeShortcutEvent = Schema.decodeUnknownSync(ShortcutEvent, strict);
export const decodeBarPointerEvent = Schema.decodeUnknownSync(BarPointerEvent, strict);
export const decodeTargetSelected = Schema.decodeUnknownSync(TargetSelected, strict);
export const decodeCaptureCommand = Schema.decodeUnknownSync(CaptureCommand, strict);
export const decodeCaptureEvent = Schema.decodeUnknownSync(CaptureEvent, strict);
export const decodeProviderRequest = Schema.decodeUnknownSync(ProviderRequest, strict);
export const decodeProviderEvent = Schema.decodeUnknownSync(ProviderEvent, strict);

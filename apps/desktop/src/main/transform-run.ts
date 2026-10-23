// The transform run reducer. Pure, like session.ts: step(state, event, now) -> { state, effects }.
// `TransformRun` has no field that can hold selected text or a result. Text exists only inside
// events and effects, so the run can sit in the store and still cannot reach a Snapshot or a log.
import type {
  InsertFailure,
  InsertMethod,
  ModelStatus,
  PillState,
  SelectionFailure,
  TransformOutcome,
} from "../shared/api.ts";
import type { TransformId } from "../shared/transforms.ts";

export type SelectionVia = "accessibility" | "copy";

export type TransformRun =
  | { phase: "idle" }
  | { phase: "reading"; id: string; transformId: TransformId }
  | { phase: "generating"; id: string; transformId: TransformId; via: SelectionVia }
  // A paste cannot be recalled, so cancel is ignored from here on.
  | { phase: "inserting"; id: string }
  | { phase: "done"; id: string; outcome: TransformOutcome };

export const idleRun: TransformRun = { phase: "idle" };

/** A run between the shortcut and its outcome, while the target app must keep focus. */
export const transforming = (run: TransformRun) => run.phase !== "idle" && run.phase !== "done";

export type GenerateFailure =
  | { kind: "tooLong"; maxWords: number }
  | { kind: "timedOut" }
  | { kind: "rejected" }
  // Engine lost or crashed. The reducer substitutes a fixed sentence; the message is never shown.
  | { kind: "error"; message: string };

export type TransformEvent =
  // The model status rides in the event, like `asr` on a dictation hotkeyDown, so the reducer
  // decides modelUnavailable before the helper touches the selection.
  | { type: "shortcut"; id: string; transformId: TransformId; model: ModelStatus }
  | { type: "selected"; id: string; text: string; via: SelectionVia }
  | { type: "selectionFailed"; id: string; failure: SelectionFailure }
  | { type: "generated"; id: string; before: string; text: string }
  | { type: "generateFailed"; id: string; failure: GenerateFailure }
  | { type: "insertResult"; id: string; method: InsertMethod; reason: InsertFailure | null }
  | { type: "cancel" }
  | { type: "helperExited" }
  | { type: "timedOut"; id: string; phase: "reading" | "generating" | "inserting" }
  | { type: "idleTimeout"; id: string };

export type TransformEffect =
  | { type: "readSelection"; id: string }
  | { type: "generate"; id: string; transformId: TransformId; text: string }
  // Sets Last transform before the write, so a refused write keeps the result.
  | { type: "keep"; transformId: TransformId; before: string; after: string }
  | { type: "insert"; id: string; text: string }
  // Emitted by every path into `done`, so the helper's Escape grab cannot outlive the run.
  | { type: "endRun"; id: string }
  | { type: "scheduleIdle"; id: string; ms: number };

export type Step = { state: TransformRun; effects: TransformEffect[] };

// 1 s release wait plus 0.5 s copy deadline plus margin.
export const READ_TIMEOUT_MS = 4000;
export const GENERATE_GRACE_MS = 2000;
export const MAX_GENERATE_BUDGET_MS = 60_000;

/** On-demand engine budget for a selection of `words` words. */
export const generateBudgetMs = (words: number) =>
  Math.min(MAX_GENERATE_BUDGET_MS, 15_000 + 40 * words);

export const SELECTION_FAILED_MESSAGE = "Could not read the selection";
export const TIMED_OUT_MESSAGE = "The transform took too long. Text unchanged";
export const REJECTED_MESSAGE = "The transform gave no usable result. Text unchanged";
export const ENGINE_STOPPED_MESSAGE = "The transform model stopped. Text unchanged";

export function step(_state: TransformRun, _event: TransformEvent, _now: number): Step {
  throw new Error("not implemented");
}

/** Null for an idle run, so the caller falls through to the dictation pill. */
export function toPillState(_run: TransformRun, _model: ModelStatus): PillState | null {
  throw new Error("not implemented");
}

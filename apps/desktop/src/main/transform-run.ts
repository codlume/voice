// The transform run reducer. Pure, like session.ts: step(state, event) -> { state, effects }.
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
import { countWords, type TransformId } from "../shared/transforms.ts";
import {
  HELPER_EXITED_MESSAGE,
  HELPER_TIMEOUT_MESSAGE,
  IDLE_AFTER_INSERTED_MS,
  IDLE_AFTER_OTHER_MS,
} from "./session.ts";

export type SelectionVia = "accessibility" | "copy";

export type TransformRun =
  | { phase: "idle" }
  | { phase: "reading"; id: string; transformId: TransformId }
  // `words` sizes the generation budget, so the watchdog is a function of this state alone.
  | { phase: "generating"; id: string; transformId: TransformId; via: SelectionVia; words: number }
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
  // Engine lost or crashed. It carries no message, so none can reach the pill or a log.
  | { kind: "error" };

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
  | { type: "generate"; id: string; transformId: TransformId; text: string; words: number }
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

function finish(id: string, outcome: TransformOutcome): Step {
  const quick = outcome.kind === "inserted" || outcome.kind === "cancelled";
  const ms = quick ? IDLE_AFTER_INSERTED_MS : IDLE_AFTER_OTHER_MS;
  return {
    state: { phase: "done", id, outcome },
    effects: [
      { type: "endRun", id },
      { type: "scheduleIdle", id, ms },
    ],
  };
}

const failed = (message: string): TransformOutcome => ({ kind: "failed", message });

function generateFailure(failure: GenerateFailure): TransformOutcome {
  switch (failure.kind) {
    case "tooLong":
      return { kind: "tooLong", maxWords: failure.maxWords };
    case "timedOut":
      return failed(TIMED_OUT_MESSAGE);
    case "rejected":
      return failed(REJECTED_MESSAGE);
    case "error":
      return failed(ENGINE_STOPPED_MESSAGE);
  }
}

/**
 * Transition table (anything not listed returns the same state and no effects). Events with an
 * `id` that is not the current run's are stale and ignored, as in session.ts. Every path into
 * `done` goes through finish(), which emits `endRun`.
 *
 *  shortcut         idle|done           model missing|downloading|failed -> done(modelUnavailable)
 *                                       otherwise -> reading + readSelection
 *                   reading..inserting  ignored (a second shortcut mid-run)
 *  selected         reading             -> generating + generate
 *  selectionFailed  reading             -> done(noSelection|secureInput|noFocusedField|keysHeld|failed)
 *  generated        generating          -> inserting + keep + insert
 *  generateFailed   generating          -> done(tooLong|failed)
 *  insertResult     inserting           -> done(inserted|notInserted)
 *  cancel           reading|generating  -> done(cancelled); inserting ignored
 *  helperExited     reading|generating  -> done(failed); inserting -> done(notInserted failed)
 *  timedOut         its own phase only  reading|generating -> done(failed); inserting -> done(notInserted failed)
 *  idleTimeout      done                -> idle
 */
export function step(state: TransformRun, event: TransformEvent): Step {
  const same = { state, effects: [] };
  const stale =
    event.type !== "shortcut" && "id" in event && (state.phase === "idle" || state.id !== event.id);
  if (stale) return same;

  switch (event.type) {
    case "shortcut": {
      if (state.phase !== "idle" && state.phase !== "done") return same;
      const { model } = event;
      if (model.state === "missing" || model.state === "failed") {
        return finish(event.id, { kind: "modelUnavailable", state: model.state });
      }
      if (model.state === "downloading") {
        return finish(event.id, {
          kind: "modelUnavailable",
          state: "downloading",
          ...(model.progress !== undefined && { progress: model.progress }),
        });
      }
      return {
        state: { phase: "reading", id: event.id, transformId: event.transformId },
        effects: [{ type: "readSelection", id: event.id }],
      };
    }
    case "selected": {
      if (state.phase !== "reading") return same;
      const words = countWords(event.text);
      return {
        state: {
          phase: "generating",
          id: state.id,
          transformId: state.transformId,
          via: event.via,
          words,
        },
        effects: [
          {
            type: "generate",
            id: state.id,
            transformId: state.transformId,
            text: event.text,
            words,
          },
        ],
      };
    }
    case "selectionFailed": {
      if (state.phase !== "reading") return same;
      if (event.failure === "failed") return finish(state.id, failed(SELECTION_FAILED_MESSAGE));
      return finish(state.id, { kind: event.failure });
    }
    case "generated": {
      if (state.phase !== "generating") return same;
      return {
        state: { phase: "inserting", id: state.id },
        effects: [
          { type: "keep", transformId: state.transformId, before: event.before, after: event.text },
          { type: "insert", id: state.id, text: event.text },
        ],
      };
    }
    case "generateFailed": {
      if (state.phase !== "generating") return same;
      return finish(state.id, generateFailure(event.failure));
    }
    case "insertResult": {
      if (state.phase !== "inserting") return same;
      if (event.method === "none") {
        return finish(state.id, { kind: "notInserted", reason: event.reason ?? "failed" });
      }
      return finish(state.id, { kind: "inserted", method: event.method });
    }
    case "cancel": {
      if (state.phase !== "reading" && state.phase !== "generating") return same;
      return finish(state.id, { kind: "cancelled" });
    }
    case "helperExited": {
      if (state.phase === "reading" || state.phase === "generating") {
        return finish(state.id, failed(HELPER_EXITED_MESSAGE));
      }
      if (state.phase === "inserting") {
        return finish(state.id, { kind: "notInserted", reason: "failed" });
      }
      return same;
    }
    case "timedOut": {
      // A watchdog armed for an earlier phase can fire after the phase moved on.
      if (state.phase !== event.phase) return same;
      if (state.phase === "reading") return finish(state.id, failed(HELPER_TIMEOUT_MESSAGE));
      if (state.phase === "generating") return finish(state.id, failed(TIMED_OUT_MESSAGE));
      return finish(state.id, { kind: "notInserted", reason: "failed" });
    }
    case "idleTimeout":
      return state.phase === "done" ? { state: idleRun, effects: [] } : same;
  }
}

/** Null for an idle run, so the caller falls through to the dictation pill. */
export function toPillState(run: TransformRun, model: ModelStatus): PillState | null {
  switch (run.phase) {
    case "idle":
      return null;
    case "reading":
    case "inserting":
      return { kind: "transforming", loading: false };
    case "generating":
      return { kind: "transforming", loading: model.state !== "ready" };
    case "done":
      return { kind: "transformDone", outcome: run.outcome };
  }
}

import { countWords } from "@voice/cleanup/words";

import type {
  InsertFailure,
  InsertMethod,
  ModelStatus,
  PillState,
  SelectionFailure,
  TransformFailureMessage,
  TransformOutcome,
} from "../shared/api.ts";
import type { TransformId } from "../shared/transforms.ts";
import {
  HELPER_EXITED_MESSAGE,
  HELPER_TIMEOUT_MESSAGE,
  IDLE_AFTER_INSERTED_MS,
  IDLE_AFTER_OTHER_MS,
} from "./session.ts";
import { budget, type Budget } from "./timing.ts";

export type SelectionVia = "accessibility" | "copy";

export type TransformRun =
  | { phase: "idle" }
  | { phase: "reading"; id: string; transformId: TransformId }
  | { phase: "generating"; id: string; transformId: TransformId; via: SelectionVia; words: number }
  | { phase: "inserting"; id: string }
  | { phase: "done"; id: string; outcome: TransformOutcome };

export const idleRun: TransformRun = { phase: "idle" };

export const transforming = (run: TransformRun) => run.phase !== "idle" && run.phase !== "done";

export type GenerateFailure =
  | { kind: "tooLong"; maxWords: number }
  | { kind: "timedOut" }
  | { kind: "rejected" }
  | { kind: "error" };

export type TransformEvent =
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
  | { type: "keep"; transformId: TransformId; before: string; after: string }
  | { type: "insert"; id: string; text: string }
  | { type: "endRun"; id: string }
  | { type: "scheduleIdle"; id: string; ms: number };

export type Step = { state: TransformRun; effects: TransformEffect[] };

export const READ_TIMEOUT_MS = 5500;
export const GENERATE_GRACE_MS = 2000;

const GENERATE_BUDGET: Budget = { base: 15_000, perWord: 40, max: 60_000 };
export const generateBudgetMs = (words: number) => budget(GENERATE_BUDGET, words);

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

const failed = (message: TransformFailureMessage): TransformOutcome => ({
  kind: "failed",
  message,
});

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
      if (state.phase !== event.phase) return same;
      if (state.phase === "reading") return finish(state.id, failed(HELPER_TIMEOUT_MESSAGE));
      if (state.phase === "generating") return finish(state.id, failed(TIMED_OUT_MESSAGE));
      return finish(state.id, { kind: "notInserted", reason: "failed" });
    }
    case "idleTimeout":
      return state.phase === "done" ? { state: idleRun, effects: [] } : same;
  }
}

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

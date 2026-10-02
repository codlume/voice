import type { ModelStatus, Outcome, PillState } from "../shared/api.ts";

export type Session =
  | { phase: "idle" }
  | { phase: "starting"; id: string; pressedAt: number; releasedAt: number | null }
  | { phase: "recording"; id: string; pressedAt: number }
  | { phase: "transcribing"; id: string }
  | { phase: "cleaning"; id: string; raw: string }
  | { phase: "inserting"; id: string; raw: string; text: string }
  | { phase: "done"; id: string; outcome: Outcome };

export type InsertMethod = "accessibility" | "paste" | "none";
export type InsertFailure = "focusChanged" | "noFocusedField" | "secureInput" | "failed";

export type SessionEvent =
  | { type: "hotkeyDown"; id: string; asr: ModelStatus["state"] }
  | { type: "hotkeyUp" }
  | { type: "cancel" }
  | { type: "captureStarted"; id: string }
  | { type: "captureFailed"; id: string; message: string }
  | { type: "transcript"; id: string; text: string; cleanup: boolean }
  | { type: "transcriptFailed"; id: string; message: string }
  | { type: "cleaned"; id: string; text: string }
  | { type: "cleanupFailed"; id: string }
  | { type: "insertResult"; id: string; method: InsertMethod; reason: InsertFailure | null }
  | { type: "helperExited" }
  | { type: "timedOut"; id: string }
  | { type: "idleTimeout"; id: string };

export type Effect =
  | { type: "startCapture"; id: string }
  | { type: "stopCapture"; id: string; releasedAt: number }
  | { type: "cancelCapture"; id: string }
  | { type: "cleanup"; id: string; raw: string }
  | { type: "insert"; id: string; text: string }
  | { type: "remember"; raw: string; text: string }
  | { type: "scheduleIdle"; id: string; ms: number };

type Step = { state: Session; effects: Effect[] };

const MIN_HOLD_MS = 250;
export const IDLE_AFTER_INSERTED_MS = 1300;
export const IDLE_AFTER_OTHER_MS = 2500;
export const ASR_MISSING_MESSAGE = "Set up the speech model in Voice first";
export const ASR_DOWNLOADING_MESSAGE = "The speech model is still downloading";
export const HELPER_EXITED_MESSAGE = "Voice helper stopped";
export const HELPER_TIMEOUT_MESSAGE = "Voice helper did not respond";

export const idle: Session = { phase: "idle" };

function finish(id: string, outcome: Outcome, ...effects: Effect[]): Step {
  const ms = outcome.kind === "inserted" ? IDLE_AFTER_INSERTED_MS : IDLE_AFTER_OTHER_MS;
  return {
    state: { phase: "done", id, outcome },
    effects: [...effects, { type: "scheduleIdle", id, ms }],
  };
}

function stopOrCancel(id: string, pressedAt: number, releasedAt: number): Step {
  if (releasedAt - pressedAt < MIN_HOLD_MS) {
    return finish(id, { kind: "tooShort" }, { type: "cancelCapture", id });
  }
  return {
    state: { phase: "transcribing", id },
    effects: [{ type: "stopCapture", id, releasedAt }],
  };
}

function insert(id: string, raw: string, text: string): Step {
  return {
    state: { phase: "inserting", id, raw, text },
    effects: [
      { type: "remember", raw, text },
      { type: "insert", id, text },
    ],
  };
}

export function step(state: Session, event: SessionEvent, now: number): Step {
  const same = { state, effects: [] };
  const stale =
    event.type !== "hotkeyDown" &&
    "id" in event &&
    (state.phase === "idle" || state.id !== event.id);
  if (stale) return same;

  switch (event.type) {
    case "hotkeyDown": {
      if (state.phase !== "idle" && state.phase !== "done") return same;
      if (event.asr === "missing" || event.asr === "failed") {
        return finish(event.id, { kind: "failed", message: ASR_MISSING_MESSAGE });
      }
      if (event.asr === "downloading") {
        return finish(event.id, { kind: "failed", message: ASR_DOWNLOADING_MESSAGE });
      }
      return {
        state: { phase: "starting", id: event.id, pressedAt: now, releasedAt: null },
        effects: [{ type: "startCapture", id: event.id }],
      };
    }
    case "hotkeyUp": {
      if (state.phase === "starting") return { state: { ...state, releasedAt: now }, effects: [] };
      if (state.phase !== "recording") return same;
      return stopOrCancel(state.id, state.pressedAt, now);
    }
    case "cancel": {
      if (state.phase !== "starting" && state.phase !== "recording") return same;
      return { state: idle, effects: [{ type: "cancelCapture", id: state.id }] };
    }
    case "captureStarted": {
      if (state.phase !== "starting") return same;
      if (state.releasedAt !== null) {
        return stopOrCancel(state.id, state.pressedAt, state.releasedAt);
      }
      return {
        state: { phase: "recording", id: state.id, pressedAt: state.pressedAt },
        effects: [],
      };
    }
    case "captureFailed": {
      if (state.phase !== "starting" && state.phase !== "recording") return same;
      return finish(state.id, { kind: "failed", message: event.message });
    }
    case "transcript": {
      const raw = event.text.trim();
      // A transcript that lands after the session already timed out is still the user's words.
      if (state.phase === "done") {
        return { state, effects: raw === "" ? [] : [{ type: "remember", raw, text: raw }] };
      }
      if (state.phase !== "transcribing" && state.phase !== "recording") return same;
      if (raw === "") return finish(state.id, { kind: "empty" });
      if (!event.cleanup) return insert(state.id, raw, raw);
      return {
        state: { phase: "cleaning", id: state.id, raw },
        effects: [
          { type: "remember", raw, text: raw },
          { type: "cleanup", id: state.id, raw },
        ],
      };
    }
    case "transcriptFailed": {
      if (state.phase !== "transcribing") return same;
      return finish(state.id, { kind: "failed", message: event.message });
    }
    case "cleaned": {
      if (state.phase !== "cleaning") return same;
      const text = event.text.trim();
      if (text === "") return finish(state.id, { kind: "empty" });
      return insert(state.id, state.raw, text);
    }
    case "cleanupFailed": {
      if (state.phase !== "cleaning") return same;
      return insert(state.id, state.raw, state.raw);
    }
    case "insertResult": {
      if (state.phase !== "inserting") return same;
      if (event.method === "none") {
        return finish(state.id, { kind: "notInserted", reason: event.reason ?? "failed" });
      }
      return finish(state.id, { kind: "inserted", method: event.method });
    }
    case "helperExited": {
      if (state.phase === "idle" || state.phase === "done") return same;
      return finish(state.id, { kind: "failed", message: HELPER_EXITED_MESSAGE });
    }
    case "timedOut": {
      if (state.phase === "starting" || state.phase === "transcribing") {
        return finish(
          state.id,
          { kind: "failed", message: HELPER_TIMEOUT_MESSAGE },
          { type: "cancelCapture", id: state.id },
        );
      }
      if (state.phase === "inserting") {
        return finish(state.id, { kind: "notInserted", reason: "failed" });
      }
      return same;
    }
    case "idleTimeout":
      return state.phase === "done" ? { state: idle, effects: [] } : same;
  }
}

export function toPillState(session: Session): PillState {
  switch (session.phase) {
    case "idle":
    case "starting":
      return { kind: "idle" };
    case "recording":
      return { kind: "listening" };
    case "transcribing":
    case "cleaning":
    case "inserting":
      return { kind: "processing" };
    case "done":
      return { kind: "done", outcome: session.outcome };
  }
}

import type { ModelStatus, Outcome, PillState } from "../shared/api.ts";

// One shortcut-triggered dictation cycle. Every phase after idle carries the session id so
// helper events from an earlier session can be dropped by id alone.
export type Session =
  | { phase: "idle" }
  | { phase: "starting"; id: string; released: boolean; pressedAt: number }
  | { phase: "recording"; id: string; pressedAt: number }
  | { phase: "transcribing"; id: string }
  | { phase: "cleaning"; id: string; raw: string }
  | { phase: "inserting"; id: string; raw: string; text: string }
  | { phase: "done"; id: string; outcome: Outcome };

export type InsertMethod = "accessibility" | "paste" | "none";
export type InsertFailure = "focusChanged" | "noFocusedField" | "secureInput" | "failed";

// Events carry the environment the decision needs (ASR state, whether cleanup should run) so
// the reducer stays a pure function of (state, event, now) and an event log replays as-is.
export type SessionEvent =
  | { type: "hotkeyDown"; id: string; asr: ModelStatus["state"] }
  | { type: "hotkeyUp" }
  | { type: "cancel" }
  | { type: "captureStarted"; id: string }
  | { type: "captureFailed"; id: string; message: string }
  | { type: "captureCancelled"; id: string }
  | { type: "transcript"; id: string; text: string; cleanup: boolean }
  | { type: "transcriptFailed"; id: string; message: string }
  | { type: "cleaned"; id: string; text: string }
  | { type: "cleanupFailed"; id: string }
  | { type: "insertResult"; id: string; method: InsertMethod; reason: InsertFailure | null }
  | { type: "helperExited" }
  | { type: "idleTimeout"; id: string };

export type Effect =
  | { type: "startCapture"; id: string }
  | { type: "stopCapture"; id: string }
  | { type: "cancelCapture"; id: string }
  | { type: "cleanup"; id: string; raw: string }
  | { type: "insert"; id: string; text: string }
  | { type: "remember"; raw: string; text: string }
  | { type: "scheduleIdle"; id: string; ms: number };

export type Step = { state: Session; effects: Effect[] };

export const MIN_HOLD_MS = 250;
export const IDLE_AFTER_INSERTED_MS = 1200;
export const IDLE_AFTER_OTHER_MS = 2500;
export const ASR_MISSING_MESSAGE = "Set up the speech model in Voice first";
export const HELPER_EXITED_MESSAGE = "Voice helper stopped";

export const idle: Session = { phase: "idle" };

function finish(id: string, outcome: Outcome, ...effects: Effect[]): Step {
  const ms = outcome.kind === "inserted" ? IDLE_AFTER_INSERTED_MS : IDLE_AFTER_OTHER_MS;
  return {
    state: { phase: "done", id, outcome },
    effects: [...effects, { type: "scheduleIdle", id, ms }],
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
      return {
        state: { phase: "starting", id: event.id, released: false, pressedAt: now },
        effects: [{ type: "startCapture", id: event.id }],
      };
    }
    case "hotkeyUp": {
      if (state.phase === "starting") return { state: { ...state, released: true }, effects: [] };
      if (state.phase !== "recording") return same;
      if (now - state.pressedAt < MIN_HOLD_MS) {
        return finish(state.id, { kind: "tooShort" }, { type: "cancelCapture", id: state.id });
      }
      return {
        state: { phase: "transcribing", id: state.id },
        effects: [{ type: "stopCapture", id: state.id }],
      };
    }
    case "cancel": {
      if (state.phase !== "starting" && state.phase !== "recording") return same;
      return { state: idle, effects: [{ type: "cancelCapture", id: state.id }] };
    }
    case "captureStarted": {
      if (state.phase !== "starting") return same;
      if (state.released) {
        return {
          state: { phase: "transcribing", id: state.id },
          effects: [{ type: "stopCapture", id: state.id }],
        };
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
    case "captureCancelled":
      return same;
    case "transcript": {
      if (state.phase !== "transcribing") return same;
      const raw = event.text.trim();
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
    case "idleTimeout":
      return state.phase === "done" ? { state: idle, effects: [] } : same;
  }
}

export function toPillState(session: Session): PillState {
  switch (session.phase) {
    // Capture is requested but the mic is not delivering frames yet, so the pill must not
    // claim to be listening.
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

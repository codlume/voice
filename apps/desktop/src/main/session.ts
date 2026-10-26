import type { CleanupStyle } from "@voice/cleanup/style";

import type {
  InsertFailure,
  InsertMethod,
  ModelStatus,
  Outcome,
  PillState,
} from "../shared/api.ts";
import type { BundleId, Category } from "../shared/app-categories.ts";
import type { Transcript } from "../shared/history.ts";
import type { TransformId } from "../shared/transforms.ts";
import {
  finalRewrite,
  rewrite,
  type Output,
  type Rewrites,
  type Rewritten,
} from "../shared/rewrite.ts";

/** Which key started the session: held for its length, or tapped once to start and again to stop. */
export type DictationMode = "hold" | "toggle";

/** The app a session's words went into, as Insights counts it. Never the website. */
export type Destination = { bundleId: BundleId; category: Category };

export type CleanupWork =
  | { kind: "style"; style: CleanupStyle }
  | { kind: "transform"; transformId: TransformId };

export type Session =
  | { phase: "idle" }
  // `releasedAt` is when the user ended capture: the hold key's release or the second toggle tap.
  | {
      phase: "starting";
      id: string;
      mode: DictationMode;
      pressedAt: number;
      releasedAt: number | null;
    }
  | { phase: "recording"; id: string; mode: DictationMode; pressedAt: number }
  | { phase: "transcribing"; id: string; overdue: boolean }
  | {
      phase: "cleaning";
      id: string;
      raw: string;
      work: CleanupWork;
      rewrites: Rewrites;
      destination: Destination | null;
      copyToClipboard: boolean;
    }
  | {
      phase: "inserting";
      id: string;
      raw: string;
      output: Output;
      insertedCleanup: string | null;
      dictionaryFixes: number;
      destination: Destination | null;
      copyToClipboard: boolean;
    }
  | { phase: "done"; id: string; outcome: Outcome };

type Cleaning = Extract<Session, { phase: "cleaning" }>;
type Inserting = Extract<Session, { phase: "inserting" }>;

export type SessionEvent =
  | { type: "hotkeyDown"; id: string; asr: ModelStatus["state"] }
  | { type: "hotkeyUp" }
  | { type: "hotkeyChord" }
  | { type: "cancel" }
  | { type: "toggle"; id: string; asr: ModelStatus["state"] }
  | { type: "captureStarted"; id: string }
  | { type: "captureFailed"; id: string; message: string }
  | { type: "captureStopped"; id: string }
  | {
      type: "transcript";
      id: string;
      text: string;
      cleanup: CleanupWork | null;
      rewrites: Rewrites;
      destination: Destination | null;
      copyToClipboard: boolean;
    }
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
  | { type: "cleanup"; id: string; raw: string; work: CleanupWork }
  | { type: "cancelCleanup"; id: string }
  | { type: "keepTransform"; transformId: TransformId; before: string; after: string }
  | { type: "insert"; id: string; output: Output }
  | ({ type: "remember" } & Transcript)
  | { type: "copy"; output: Output }
  | {
      type: "dictated";
      id: string;
      raw: string;
      insertedCleanup: string | null;
      dictionaryFixes: number;
      destination: Destination | null;
    }
  | { type: "scheduleIdle"; id: string; ms: number };

type Step = { state: Session; effects: Effect[] };

const MIN_HOLD_MS = 250;
export const IDLE_AFTER_INSERTED_MS = 1300;
export const IDLE_AFTER_OTHER_MS = 2500;
export const INSERT_TIMEOUT_MS = 5000;
export const ASR_MISSING_MESSAGE = "Set up the speech model in Voice first";
export const ASR_DOWNLOADING_MESSAGE = "The speech model is still downloading";
export const HELPER_EXITED_MESSAGE = "Voice helper stopped";
export const HELPER_TIMEOUT_MESSAGE = "Voice helper did not respond";
export const TRANSCRIBE_GAVE_UP_MESSAGE = "Transcription did not finish";

export const idle: Session = { phase: "idle" };

/** A session between the hotkey and its outcome, while the target app must keep focus. */
export const dictating = (session: Session) => session.phase !== "idle" && session.phase !== "done";

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
    state: { phase: "transcribing", id, overdue: false },
    effects: [{ type: "stopCapture", id, releasedAt }],
  };
}

function start(id: string, asr: ModelStatus["state"], mode: DictationMode, now: number): Step {
  if (asr === "missing" || asr === "failed") {
    return finish(id, { kind: "failed", message: ASR_MISSING_MESSAGE });
  }
  if (asr === "downloading")
    return finish(id, { kind: "failed", message: ASR_DOWNLOADING_MESSAGE });
  return {
    state: { phase: "starting", id, mode, pressedAt: now, releasedAt: null },
    effects: [{ type: "startCapture", id }],
  };
}

/** The user ended capture. Before capture has started, the end is stamped and applied once it does. */
function endCapture(
  state: Extract<Session, { phase: "starting" | "recording" }>,
  now: number,
): Step {
  if (state.phase === "recording") return stopOrCancel(state.id, state.pressedAt, now);
  if (state.releasedAt !== null) return { state, effects: [] };
  return { state: { ...state, releasedAt: now }, effects: [] };
}

function inserting(
  id: string,
  raw: string,
  { text, html, dictionaryFixes }: Rewritten,
  insertedCleanup: string | null,
  destination: Destination | null,
  copyToClipboard: boolean,
): Inserting {
  return {
    phase: "inserting",
    id,
    raw,
    output: { text, html },
    insertedCleanup,
    dictionaryFixes,
    destination,
    copyToClipboard,
  };
}

function insert(state: Inserting): Step {
  const { id, raw, output } = state;
  return {
    state,
    effects: [
      { type: "remember", id, raw, text: output.text, status: "pending" },
      { type: "insert", id, output },
    ],
  };
}

function uncleaned(state: Cleaning): Inserting {
  const { id, raw, rewrites, destination, copyToClipboard } = state;
  return inserting(id, raw, rewrite(raw, rewrites), null, destination, copyToClipboard);
}

function produced(
  state: Inserting,
  outcome: Extract<Outcome, { kind: "inserted" }> | { kind: "notInserted"; reason: InsertFailure },
  ...effects: Effect[]
): Step {
  const { id, raw, insertedCleanup, dictionaryFixes, destination, copyToClipboard } = state;
  const kept: Effect[] = [
    { type: "dictated", id, raw, insertedCleanup, dictionaryFixes, destination },
  ];
  if (copyToClipboard) kept.push({ type: "copy", output: state.output });
  const settled: Outcome =
    outcome.kind === "notInserted" ? { ...outcome, copied: copyToClipboard } : outcome;
  return finish(id, settled, ...effects, ...kept);
}

export function step(state: Session, event: SessionEvent, now: number): Step {
  const same = { state, effects: [] };
  const stale =
    event.type !== "hotkeyDown" &&
    event.type !== "toggle" &&
    event.type !== "transcript" &&
    "id" in event &&
    (state.phase === "idle" || state.id !== event.id);
  if (stale) return same;

  switch (event.type) {
    case "hotkeyDown": {
      if (state.phase !== "idle" && state.phase !== "done") return same;
      return start(event.id, event.asr, "hold", now);
    }
    case "toggle": {
      if (state.phase === "idle" || state.phase === "done") {
        return start(event.id, event.asr, "toggle", now);
      }
      if (state.phase !== "starting" && state.phase !== "recording") return same;
      if (state.mode !== "toggle") return same;
      return endCapture(state, now);
    }
    case "hotkeyUp": {
      if (state.phase !== "starting" && state.phase !== "recording") return same;
      if (state.mode !== "hold") return same;
      return endCapture(state, now);
    }
    case "hotkeyChord": {
      if (state.phase !== "starting" && state.phase !== "recording") return same;
      if (state.mode !== "hold") return same;
      return { state: idle, effects: [{ type: "cancelCapture", id: state.id }] };
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
        state: { phase: "recording", id: state.id, mode: state.mode, pressedAt: state.pressedAt },
        effects: [],
      };
    }
    case "captureFailed": {
      if (state.phase !== "starting" && state.phase !== "recording") return same;
      return finish(state.id, { kind: "failed", message: event.message });
    }
    case "captureStopped": {
      if (state.phase !== "recording") return same;
      return { state: { phase: "transcribing", id: state.id, overdue: false }, effects: [] };
    }
    case "transcript": {
      const raw = event.text.trim();
      const current = state.phase !== "idle" && state.id === event.id;
      // A second transcript for the session already being cleaned or inserted is a duplicate.
      if (current && (state.phase === "cleaning" || state.phase === "inserting")) return same;
      const sessionOver =
        !current || (state.phase !== "transcribing" && state.phase !== "recording");
      if (sessionOver) {
        const remember: Effect = {
          type: "remember",
          id: event.id,
          raw,
          text: raw,
          status: "notInserted",
        };
        return { state, effects: raw === "" ? [] : [remember] };
      }
      if (raw === "") return finish(state.id, { kind: "empty" });
      const rewritten = rewrite(raw, event.rewrites);
      // A dictation that is only a trigger types the saved text verbatim; cleanup could only damage it.
      if (event.cleanup === null || rewritten.entireDictation) {
        return insert(
          inserting(state.id, raw, rewritten, null, event.destination, event.copyToClipboard),
        );
      }
      return {
        state: {
          phase: "cleaning",
          id: state.id,
          raw,
          work: event.cleanup,
          rewrites: event.rewrites,
          destination: event.destination,
          copyToClipboard: event.copyToClipboard,
        },
        effects: [
          { type: "remember", id: state.id, raw, text: rewritten.text, status: "pending" },
          { type: "cleanup", id: state.id, raw, work: event.cleanup },
        ],
      };
    }
    case "transcriptFailed": {
      if (state.phase !== "transcribing" && state.phase !== "recording") return same;
      return finish(state.id, { kind: "failed", message: event.message });
    }
    case "cleaned": {
      if (state.phase !== "cleaning") return same;
      const cleaned = event.text.trim();
      const final = finalRewrite(state.raw, cleaned, state.rewrites);
      if (final.text === "") {
        return finish(state.id, { kind: "empty" }, { type: "cancelCapture", id: state.id });
      }
      const next = insert(
        inserting(
          state.id,
          state.raw,
          final,
          final.source === "cleaned" && state.work.kind === "style" ? cleaned : null,
          state.destination,
          state.copyToClipboard,
        ),
      );
      if (state.work.kind === "style") return next;
      const keep: Effect = {
        type: "keepTransform",
        transformId: state.work.transformId,
        before: state.raw,
        after: final.text,
      };
      return { ...next, effects: [keep, ...next.effects] };
    }
    case "cleanupFailed": {
      if (state.phase !== "cleaning") return same;
      return insert(uncleaned(state));
    }
    case "insertResult": {
      if (state.phase !== "inserting") return same;
      if (event.method === "none") {
        return produced(state, { kind: "notInserted", reason: event.reason ?? "failed" });
      }
      return produced(state, { kind: "inserted", method: event.method });
    }
    case "helperExited": {
      if (state.phase === "idle" || state.phase === "done") return same;
      const lost = { kind: "notInserted", reason: "failed" } as const;
      if (state.phase === "cleaning") {
        return produced(uncleaned(state), lost, { type: "cancelCleanup", id: state.id });
      }
      if (state.phase === "inserting") return produced(state, lost);
      return finish(state.id, { kind: "failed", message: HELPER_EXITED_MESSAGE });
    }
    case "timedOut": {
      if (state.phase === "starting") {
        return finish(
          state.id,
          { kind: "failed", message: HELPER_TIMEOUT_MESSAGE },
          { type: "cancelCapture", id: state.id },
        );
      }
      // A cancel makes the helper discard the audio, so the first deadline only tells the user.
      if (state.phase === "transcribing") {
        if (!state.overdue) return { state: { ...state, overdue: true }, effects: [] };
        return finish(
          state.id,
          { kind: "failed", message: TRANSCRIBE_GAVE_UP_MESSAGE },
          { type: "cancelCapture", id: state.id },
        );
      }
      if (state.phase === "inserting") {
        return produced(state, { kind: "notInserted", reason: "failed" });
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
      return { kind: "processing", overdue: session.overdue };
    case "cleaning":
    case "inserting":
      return { kind: "processing", overdue: false };
    case "done":
      return { kind: "done", outcome: session.outcome };
  }
}

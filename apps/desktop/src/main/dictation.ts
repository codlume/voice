import { randomUUID } from "node:crypto";

import type { Cleanup } from "./cleanup.ts";
import type { HelperCommand, HelperEvent } from "./protocol.ts";
import { step, type Effect, type Session, type SessionEvent } from "./session.ts";
import type { Store } from "./store.ts";

export type DictationOptions = {
  store: Store;
  send: (command: HelperCommand) => void;
  cleanup: Pick<Cleanup, "clean" | "loaded">;
  onLevel: (level: number) => void;
  log: (message: string) => void;
  now?: () => number;
};

export const CLEANUP_BASE_MS = 2000;
export const CLEANUP_PER_WORD_MS = 20;
export const CLEANUP_MAX_MS = 8000;

export function cleanupBudgetMs(raw: string): number {
  const words = raw.split(/\s+/).filter(Boolean).length;
  return Math.min(CLEANUP_MAX_MS, CLEANUP_BASE_MS + CLEANUP_PER_WORD_MS * words);
}

export const START_TIMEOUT_MS = 3000;
export const TRANSCRIBE_TIMEOUT_MS = 30_000;
// A release while the speech model is still loading waits for the load and the transcription.
export const TRANSCRIBE_WHILE_LOADING_TIMEOUT_MS = 60_000;
export const INSERT_TIMEOUT_MS = 5000;

export type Dictation = {
  dispatch(event: SessionEvent): void;
  onHelperEvent(event: HelperEvent): void;
};

type Timing = {
  id: string;
  pressedAt: number;
  startMs?: number;
  releasedAt?: number;
  audioMs?: number;
  asrMs?: number;
  cleanupStartedAt?: number;
  cleanupMs?: number;
  insertStartedAt?: number;
  insertMs?: number;
};

export function createDictation(options: DictationOptions): Dictation {
  const { store, send, cleanup, log } = options;
  const now = options.now ?? Date.now;
  let idleTimer: NodeJS.Timeout | null = null;
  let timing: Timing | null = null;
  let watchdog: NodeJS.Timeout | null = null;
  let cleaning = false;

  function dispatch(event: SessionEvent) {
    const before = store.state.session;
    const { state, effects } = step(before, event, now());
    for (const effect of effects) run(effect);
    if (state !== before) {
      store.update((s) => ({ ...s, session: state }));
      armWatchdog(state);
    }
    if (state.phase === "done" && before.phase !== "done") logTiming(state.id, state.outcome.kind);
  }

  function armWatchdog(state: Session) {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    const arm = (id: string, ms: number) => {
      watchdog = setTimeout(() => dispatch({ type: "timedOut", id }), ms);
    };
    if (state.phase === "starting") {
      arm(state.id, START_TIMEOUT_MS);
    } else if (state.phase === "transcribing") {
      const ready = store.state.models.asr.state === "ready";
      arm(state.id, ready ? TRANSCRIBE_TIMEOUT_MS : TRANSCRIBE_WHILE_LOADING_TIMEOUT_MS);
    } else if (state.phase === "inserting") {
      arm(state.id, INSERT_TIMEOUT_MS);
    }
  }

  function run(effect: Effect) {
    switch (effect.type) {
      case "startCapture":
        if (idleTimer) clearTimeout(idleTimer);
        timing = { id: effect.id, pressedAt: now() };
        send({ type: "capture.start", id: effect.id });
        return;
      case "stopCapture":
        if (timing) timing.releasedAt = now();
        send({ type: "capture.stop", id: effect.id });
        return;
      case "cancelCapture":
        send({ type: "capture.cancel", id: effect.id });
        return;
      case "cleanup": {
        const startedAt = now();
        if (timing) timing.cleanupStartedAt = startedAt;
        const { enabled: _enabled, ...style } = store.state.settings.cleanup;
        let settled = false;
        cleaning = true;
        const budget = setTimeout(() => {
          settled = true;
          log(`cleanup timed out after ${cleanupBudgetMs(effect.raw)} ms`);
          dispatch({ type: "cleanupFailed", id: effect.id });
        }, cleanupBudgetMs(effect.raw));
        void cleanup
          .clean(effect.raw, style)
          .finally(() => {
            cleaning = false;
          })
          .then(
            (text) => {
              if (settled) return;
              settled = true;
              clearTimeout(budget);
              if (timing?.id === effect.id) timing.cleanupMs = now() - startedAt;
              dispatch({ type: "cleaned", id: effect.id, text });
            },
            (error: unknown) => {
              if (settled) return;
              settled = true;
              clearTimeout(budget);
              log(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
              dispatch({ type: "cleanupFailed", id: effect.id });
            },
          );
        return;
      }
      case "insert":
        if (timing) timing.insertStartedAt = now();
        send({ type: "insert", id: effect.id, text: effect.text });
        return;
      case "remember":
        store.update((s) => ({ ...s, last: { raw: effect.raw, text: effect.text } }));
        return;
      case "scheduleIdle":
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => dispatch({ type: "idleTimeout", id: effect.id }), effect.ms);
        return;
    }
  }

  function logTiming(id: string, outcome: string) {
    const t = timing?.id === id ? timing : null;
    const finishedAt = now();
    const fields = {
      startMs: t?.startMs,
      audioMs: t?.audioMs,
      asrMs: t?.asrMs,
      cleanupMs: t?.cleanupMs,
      insertMs: t?.insertStartedAt === undefined ? undefined : finishedAt - t.insertStartedAt,
      releaseToInsertMs:
        t?.releasedAt === undefined || outcome !== "inserted"
          ? undefined
          : finishedAt - t.releasedAt,
    };
    const parts = Object.entries(fields).flatMap(([key, value]) =>
      value === undefined ? [] : [`${key}=${Math.round(value)}`],
    );
    log(`session ${id.slice(0, 8)} outcome=${outcome} ${parts.join(" ")}`);
  }

  function onHelperEvent(event: HelperEvent) {
    switch (event.type) {
      case "ready":
        log(`helper ready (protocol v${event.version})`);
        return;
      case "hotkey":
        if (event.action === "down") {
          dispatch({ type: "hotkeyDown", id: randomUUID(), asr: store.state.models.asr.state });
        } else {
          dispatch({ type: event.action === "up" ? "hotkeyUp" : "cancel" });
        }
        return;
      case "capture.started":
        if (timing?.id === event.id) timing.startMs = event.startMs;
        dispatch({ type: "captureStarted", id: event.id });
        return;
      case "capture.level":
        options.onLevel(event.level);
        return;
      case "capture.failed":
        dispatch({ type: "captureFailed", id: event.id, message: event.message });
        return;
      case "capture.cancelled":
        return;
      case "transcript": {
        if (timing?.id === event.id) {
          timing.audioMs = event.audioMs;
          timing.asrMs = event.asrMs;
        }
        const runCleanup = store.state.settings.cleanup.enabled && cleanup.loaded();
        if (runCleanup && cleaning)
          log("cleanup still busy with an earlier session, inserting raw");
        dispatch({
          type: "transcript",
          id: event.id,
          text: event.text,
          cleanup: runCleanup && !cleaning,
        });
        return;
      }
      case "transcript.failed":
        dispatch({ type: "transcriptFailed", id: event.id, message: event.message });
        return;
      case "insert.result":
        dispatch({
          type: "insertResult",
          id: event.id,
          method: event.method,
          reason: event.reason,
        });
        return;
      case "permissions":
        store.update((s) => ({
          ...s,
          permissions: { microphone: event.microphone, accessibility: event.accessibility },
        }));
        return;
      case "asr.status":
        store.update((s) => ({
          ...s,
          models: {
            ...s.models,
            asr:
              event.state === "failed"
                ? { state: "failed", message: event.message ?? "Speech model failed to load" }
                : { state: event.state },
          },
        }));
        return;
      case "log":
        log(`helper ${event.level}: ${event.message}`);
        return;
    }
  }

  return { dispatch, onHelperEvent };
}

import { randomUUID } from "node:crypto";

import * as Effect from "effect/Effect";

import type { Outcome } from "../shared/api.ts";
import { supportsCleanup, type DictationLanguage } from "../shared/dictation-language.ts";
import type { Cleanup } from "./cleanup.ts";
import { errorType, isHelperLog, type DiagnosticLog, type Log } from "./diagnostics-scrub.ts";
import type { HelperCommand, HelperEvent } from "./protocol.ts";
import { step, type Effect as SessionEffect, type Session, type SessionEvent } from "./session.ts";
import type { Store } from "./store.ts";

export type DictationOptions = {
  store: Store;
  send: (command: HelperCommand) => void;
  cleanup: Pick<Cleanup, "clean" | "loaded">;
  onLevel: (level: number) => void;
  log: Log;
  onSessionDone: (report: SessionReport) => void;
  now?: () => number;
};

export const CLEANUP_BASE_MS = 2000;
export const CLEANUP_PER_WORD_MS = 20;
export const CLEANUP_MAX_MS = 8000;

export function cleanupBudgetMs(raw: string): number {
  const words = raw.split(/\s+/).filter(Boolean).length;
  return Math.min(CLEANUP_MAX_MS, CLEANUP_BASE_MS + CLEANUP_PER_WORD_MS * words);
}

type CleanupFailure = { message: string; entry: DiagnosticLog };

export const START_TIMEOUT_MS = 3000;
export const TRANSCRIBE_TIMEOUT_MS = 30_000;
// A release while the speech model is still loading waits for the load and the transcription.
export const TRANSCRIBE_WHILE_LOADING_TIMEOUT_MS = 60_000;
export const INSERT_TIMEOUT_MS = 5000;

export type Dictation = {
  dispatch(event: SessionEvent): void;
  onHelperEvent(event: HelperEvent): void;
};

type Started = {
  id: string;
  language: DictationLanguage;
  pressedAt: number;
  startMs?: number;
  releasedAt?: number;
  audioMs?: number;
  asrMs?: number;
  cleanupMs?: number;
  insertStartedAt?: number;
};

export type SessionTimings = {
  startMs?: number | undefined;
  audioMs?: number | undefined;
  asrMs?: number | undefined;
  cleanupMs?: number | undefined;
  insertMs?: number | undefined;
  releaseToInsertMs?: number | undefined;
};

// Carries no text, session id, or target: this is what diagnostics may see of a session.
export type SessionReport = {
  outcome: Outcome;
  finishedAt: number;
  capture: { language: DictationLanguage; pressedAt: number; timings: SessionTimings } | null;
};

function sessionTimings(s: Started, outcome: Outcome["kind"], finishedAt: number): SessionTimings {
  return {
    startMs: s.startMs,
    audioMs: s.audioMs,
    asrMs: s.asrMs,
    cleanupMs: s.cleanupMs,
    insertMs: s.insertStartedAt === undefined ? undefined : finishedAt - s.insertStartedAt,
    releaseToInsertMs:
      s.releasedAt === undefined || outcome !== "inserted" ? undefined : finishedAt - s.releasedAt,
  };
}

export function createDictation(options: DictationOptions): Dictation {
  const { store, send, cleanup, log } = options;
  const now = options.now ?? Date.now;
  let idleTimer: NodeJS.Timeout | null = null;
  let started: Started | null = null;

  function track(id: string, patch: Partial<Omit<Started, "id" | "language" | "pressedAt">>) {
    if (started?.id === id) Object.assign(started, patch);
  }
  let watchdog: NodeJS.Timeout | null = null;

  function dispatch(event: SessionEvent) {
    const before = store.state.session;
    const { state, effects } = step(before, event, now());
    for (const effect of effects) run(effect);
    if (state !== before) {
      store.update((s) => ({ ...s, session: state }));
      armWatchdog(state);
    }
    if (state.phase === "done" && before.phase !== "done") finish(state.id, state.outcome);
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

  function run(effect: SessionEffect) {
    switch (effect.type) {
      case "startCapture":
        if (idleTimer) clearTimeout(idleTimer);
        started = {
          id: effect.id,
          language: store.state.settings.dictationLanguage,
          pressedAt: now(),
        };
        send({
          type: "capture.start",
          id: effect.id,
          language: started.language,
          muteWhileDictating: store.state.settings.muteWhileDictating,
          microphone: store.state.settings.microphone,
        });
        return;
      case "stopCapture":
        track(effect.id, { releasedAt: now() });
        send({ type: "capture.stop", id: effect.id });
        return;
      case "cancelCapture":
        send({ type: "capture.cancel", id: effect.id });
        return;
      case "cleanup": {
        const startedAt = now();
        const { styling } = store.state.settings.cleanup;
        const budgetMs = cleanupBudgetMs(effect.raw);
        Effect.runFork(
          Effect.tryPromise({
            try: (signal) => cleanup.clean(effect.raw, { styling }, signal),
            catch: (error): CleanupFailure => ({
              message: `cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
              entry: {
                message: "cleanup failed",
                level: "warn",
                attributes: { "error.type": errorType(error) },
              },
            }),
          }).pipe(
            Effect.timeoutFail({
              duration: budgetMs,
              onTimeout: (): CleanupFailure => ({
                message: `cleanup timed out after ${budgetMs} ms`,
                entry: {
                  message: "cleanup timed out",
                  level: "warn",
                  attributes: { "cleanup.budget_ms": budgetMs },
                },
              }),
            }),
            Effect.match({
              onSuccess: (text) => {
                track(effect.id, { cleanupMs: now() - startedAt });
                dispatch({ type: "cleaned", id: effect.id, text });
              },
              onFailure: ({ message, entry }) => {
                log(message, entry);
                dispatch({ type: "cleanupFailed", id: effect.id });
              },
            }),
          ),
        );
        return;
      }
      case "insert":
        track(effect.id, { insertStartedAt: now() });
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

  function finish(id: string, outcome: Outcome) {
    const s = started?.id === id ? started : null;
    const finishedAt = now();
    const capture = s && {
      language: s.language,
      pressedAt: s.pressedAt,
      timings: sessionTimings(s, outcome.kind, finishedAt),
    };
    const parts = Object.entries(capture?.timings ?? {}).flatMap(([key, value]) =>
      value === undefined ? [] : [`${key}=${Math.round(value)}`],
    );
    log(`session ${id.slice(0, 8)} outcome=${outcome.kind} ${parts.join(" ")}`);
    options.onSessionDone({ outcome, finishedAt, capture });
  }

  function onHelperEvent(event: HelperEvent) {
    switch (event.type) {
      case "ready":
        log(`helper ready (protocol v${event.version})`, {
          message: "helper ready",
          level: "info",
          attributes: { "helper.protocol_version": event.version },
        });
        return;
      case "hotkey":
        if (event.action === "down") {
          dispatch({ type: "hotkeyDown", id: randomUUID(), asr: store.state.models.asr.state });
        } else {
          dispatch({ type: event.action === "up" ? "hotkeyUp" : "cancel" });
        }
        return;
      case "capture.started":
        track(event.id, { startMs: event.startMs });
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
        track(event.id, { audioMs: event.audioMs, asrMs: event.asrMs });
        dispatch({
          type: "transcript",
          id: event.id,
          text: event.text,
          cleanup:
            started?.id === event.id &&
            supportsCleanup(started.language) &&
            store.state.settings.cleanup.enabled &&
            cleanup.loaded(),
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
      case "microphones.changed":
        store.update((s) => ({
          ...s,
          microphones: { kind: "ready", devices: event.devices, defaultUid: event.defaultUid },
        }));
        return;
      case "microphones.unavailable":
        store.update((s) => ({
          ...s,
          microphones: { kind: "unavailable", message: event.message },
        }));
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
        log(
          `helper ${event.level}: ${event.message}`,
          isHelperLog(event.message) ? { message: event.message, level: event.level } : undefined,
        );
        return;
    }
  }

  return { dispatch, onHelperEvent };
}

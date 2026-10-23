import { randomUUID } from "node:crypto";

import type { CleanupStyle } from "@voice/cleanup/style";
import * as Effect from "effect/Effect";

import type { Outcome } from "../shared/api.ts";
import {
  supportsCleanup,
  wantsCleanup,
  type DictationLanguage,
} from "../shared/dictation-language.ts";
import type { Output } from "../shared/rewrite.ts";
import { classify, cleanupStyleFor } from "../shared/style.ts";
import { countWords, type LastTransform, type TransformId } from "../shared/transforms.ts";
import { activity } from "./activity.ts";
import type { Cleanup } from "./cleanup.ts";
import { errorType, isHelperLog, type DiagnosticLog, type Log } from "./diagnostics-scrub.ts";
import type { History } from "./history.ts";
import type { HelperCommand, HelperEvent } from "./protocol.ts";
import {
  INSERT_TIMEOUT_MS,
  step,
  type Destination,
  type Effect as SessionEffect,
  type Session,
  type SessionEvent,
} from "./session.ts";
import type { Store } from "./store.ts";
import { budget, timingLine, type Budget } from "./timing.ts";
import type { TransformModel } from "./transform-model.ts";

export type DictationOptions = {
  store: Store;
  send: (command: HelperCommand) => void;
  cleanup: Pick<Cleanup, "clean" | "loaded" | "keepGpuBusy" | "letGpuIdle">;
  /** Auto-apply after dictation: the transform model, and Last transform for recovery. */
  transform: {
    model: Pick<TransformModel, "run" | "warm" | "onDisk">;
    remember: (value: Omit<LastTransform, "finishedAt">) => void;
  };
  onLevel: (level: number) => void;
  log: Log;
  onSessionDone: (report: SessionReport) => void;
  onDictated: (dictated: Dictated) => void;
  history: Pick<History, "remember" | "settle">;
  copy: (output: Output) => void;
  now?: () => number;
};

export const CLEANUP_BUDGET: Budget = { base: 2000, perWord: 20, max: 8000 };
export const CLEANUP_GRACE_MS = 1000;
export const cleanupBudgetMs = (raw: string) => budget(CLEANUP_BUDGET, countWords(raw));

// #311: the measured auto-apply times plus about 30% headroom.
export const AUTO_APPLY_BUDGET: Budget = { base: 2000, perWord: 30, max: 20_000 };
export const autoApplyBudgetMs = (raw: string) => budget(AUTO_APPLY_BUDGET, countWords(raw));

type CleanupFailure = { message: string; entry: DiagnosticLog };

export const START_TIMEOUT_MS = 3000;
export const TRANSCRIBE_TIMEOUT_MS = 30_000;
// A release while the speech model is still loading waits for the load and the transcription.
export const TRANSCRIBE_WHILE_LOADING_TIMEOUT_MS = 60_000;
export const TRANSCRIBE_OVERDUE_MIN_MS = 30_000;

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
  speechMs?: number | null;
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

export type Dictated = {
  raw: string;
  insertedCleanup: string | null;
  dictionaryFixes: number;
  language: DictationLanguage;
  paceMs: number | null;
  finishedAt: number;
  destination: Destination | null;
};

type Work = { kind: "transform"; transformId: TransformId } | { kind: "style" } | null;

const gaveTranscript = (outcome: Outcome) =>
  outcome.kind === "inserted" || outcome.kind === "notInserted";

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

  // The auto-apply transform when one is set and its model is on disk, else S1-mini cleanup. The
  // English gate is S1-mini's alone. The language is the one captured at the start of the session,
  // not the current setting. The style comes from the target, which only the transcript has.
  function workFor(id: string): Work {
    if (started?.id !== id) return null;
    const { settings } = store.state;
    const { enabled, items, autoApply } = settings.transforms;
    const transform = enabled ? items.find((item) => item.id === autoApply) : undefined;
    if (transform && options.transform.model.onDisk()) {
      return { kind: "transform", transformId: transform.id };
    }
    if (supportsCleanup(started.language) && settings.cleanup.enabled && cleanup.loaded()) {
      return { kind: "style" };
    }
    return null;
  }

  function dispatch(event: SessionEvent) {
    const before = store.state.session;
    const { state, effects } = step(before, event, now());
    if (state !== before) {
      store.update((s) => ({ ...s, session: state }));
      const overdue =
        state.phase === "transcribing" && before.phase === "transcribing" && state.overdue;
      if (state.phase !== before.phase || overdue) armWatchdog(state);
      // Transcription is the window to keep the GPU clocked up for the clean that follows.
      if (state.phase !== before.phase) {
        if (state.phase === "transcribing" && workFor(state.id)?.kind === "style") {
          cleanup.keepGpuBusy();
        } else if (before.phase === "transcribing" && state.phase !== "cleaning") {
          cleanup.letGpuIdle();
        }
      }
    }
    for (const effect of effects) run(effect);
    if (state.phase === "done" && (before.phase !== "done" || before.id !== state.id)) {
      // After the outcome, so the helper's paste fallback sees a changed clipboard and skips
      // restoring the previous contents. Copying earlier would race the helper saving them.
      if (before.phase === "inserting" && store.state.settings.copyToClipboard) {
        options.copy(before.output);
      }
      finish(state.id, state.outcome, before.phase === "inserting" ? before : null);
    }
  }

  function armWatchdog(state: Session) {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    const arm = (id: string, ms: number) => {
      watchdog = setTimeout(() => dispatch({ type: "timedOut", id }), ms);
    };
    if (state.phase === "starting") {
      arm(state.id, START_TIMEOUT_MS);
    } else if (state.phase === "transcribing" && state.overdue) {
      const hold = started?.id === state.id ? (started.releasedAt ?? now()) - started.pressedAt : 0;
      arm(state.id, Math.max(TRANSCRIBE_OVERDUE_MIN_MS, hold));
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
          detectHost: wantsCleanup(store.state.settings),
        });
        // Loading starts while the user speaks. warm() only schedules the load, so the capture
        // command above is on its way before any heavy work.
        if (workFor(effect.id)?.kind === "transform") options.transform.model.warm();
        return;
      case "stopCapture":
        track(effect.id, { releasedAt: effect.releasedAt });
        send({ type: "capture.stop", id: effect.id });
        return;
      case "cancelCapture":
        send({ type: "capture.cancel", id: effect.id });
        return;
      case "cleanup": {
        const { id, raw, work } = effect;
        const startedAt = now();
        const budgetMs = work.kind === "style" ? cleanupBudgetMs(raw) : autoApplyBudgetMs(raw);
        Effect.runFork(
          Effect.tryPromise({
            try: (signal) =>
              work.kind === "style"
                ? clean(raw, work.style, budgetMs, signal)
                : applyTransform(raw, work.transformId, budgetMs, signal),
            catch: (error): CleanupFailure => ({
              message: `cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
              entry: {
                message: "cleanup failed",
                level: "warn",
                attributes: { "error.type": errorType(error) },
              },
            }),
          }).pipe(
            Effect.timeoutOrElse({
              duration: budgetMs + CLEANUP_GRACE_MS,
              orElse: () =>
                Effect.fail<CleanupFailure>({
                  message: `cleanup timed out after ${budgetMs + CLEANUP_GRACE_MS} ms`,
                  entry: {
                    message: "cleanup timed out",
                    level: "warn",
                    attributes: { "cleanup.budget_ms": budgetMs },
                  },
                }),
            }),
            Effect.match({
              onSuccess: (text) => {
                track(id, { cleanupMs: now() - startedAt });
                dispatch({ type: "cleaned", id, text });
              },
              onFailure: ({ message, entry }) => {
                log(message, entry);
                dispatch({ type: "cleanupFailed", id });
              },
            }),
          ),
        );
        return;
      }
      case "keepTransform": {
        // With History off, Last transform is where the user's own words can be recovered.
        const { items } = store.state.settings.transforms;
        options.transform.remember({
          name: items.find((item) => item.id === effect.transformId)?.name ?? "Transform",
          before: effect.before,
          after: effect.after,
        });
        return;
      }
      case "insert":
        track(effect.id, { insertStartedAt: now() });
        send({ type: "insert", id: effect.id, text: effect.output.text, html: effect.output.html });
        return;
      case "remember":
        options.history.remember(
          { id: effect.id, raw: effect.raw, text: effect.text, status: effect.status },
          now(),
        );
        return;
      case "scheduleIdle":
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => dispatch({ type: "idleTimeout", id: effect.id }), effect.ms);
        return;
    }
  }

  async function clean(
    raw: string,
    style: CleanupStyle,
    budgetMs: number,
    signal: AbortSignal,
  ): Promise<string> {
    const { text, chunks, cleaned } = await cleanup.clean(raw, style, { budgetMs, signal });
    if (cleaned < chunks) {
      log(`cleanup partial: ${cleaned} of ${chunks} chunks cleaned, budget ${budgetMs} ms`, {
        message: "cleanup partial",
        level: "info",
        attributes: {
          "cleanup.chunks": chunks,
          "cleanup.cleaned": cleaned,
          "cleanup.budget_ms": budgetMs,
        },
      });
    }
    return text;
  }

  // Every failure, a refused result included, takes the transcript path.
  async function applyTransform(
    raw: string,
    transformId: TransformId,
    budgetMs: number,
    signal: AbortSignal,
  ): Promise<string> {
    const transform = store.state.settings.transforms.items.find((item) => item.id === transformId);
    if (!transform) throw new Error("the auto-apply transform was removed");
    const result = await options.transform.model.run({
      instruction: transform.instruction,
      text: raw,
      dictation: true,
      budgetMs,
      signal,
    });
    if (!result.ok) throw new Error(`transform ${result.failure.kind}`);
    return result.text;
  }

  function finish(
    id: string,
    outcome: Outcome,
    produced: Extract<Session, { phase: "inserting" }> | null,
  ) {
    const s = started?.id === id ? started : null;
    const finishedAt = now();
    const capture = s && {
      language: s.language,
      pressedAt: s.pressedAt,
      timings: sessionTimings(s, outcome.kind, finishedAt),
    };
    log(timingLine("session", id, outcome.kind, capture?.timings ?? {}));
    options.onSessionDone({ outcome, finishedAt, capture });
    options.history.settle(id, outcome.kind === "inserted");
    if (produced && gaveTranscript(outcome)) {
      options.onDictated({
        raw: produced.raw,
        insertedCleanup: produced.insertedCleanup,
        dictionaryFixes: produced.dictionaryFixes,
        language: s?.language ?? "auto",
        paceMs: s?.speechMs ?? s?.audioMs ?? null,
        finishedAt,
        destination: produced.destination,
      });
    }
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
      case "hotkey": {
        const asr = store.state.models.asr.state;
        // A transform run owns the target's focus until its write; a dictation cannot start over it.
        if (
          (event.action === "down" || event.action === "toggle") &&
          activity(store.state) === "transform"
        ) {
          return;
        }
        switch (event.action) {
          case "down":
            return dispatch({ type: "hotkeyDown", id: randomUUID(), asr });
          case "toggle":
            return dispatch({ type: "toggle", id: randomUUID(), asr });
          case "up":
            return dispatch({ type: "hotkeyUp" });
          case "chord":
            return dispatch({ type: "hotkeyChord" });
          case "cancel":
            return dispatch({ type: "cancel" });
        }
        return;
      }
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
      case "capture.stopped":
        log(`helper stopped capture: ${event.reason}`, {
          message: "helper stopped capture",
          level: "info",
          attributes: { "capture.stop_reason": event.reason },
        });
        dispatch({ type: "captureStopped", id: event.id });
        return;
      case "transcript": {
        track(event.id, {
          audioMs: event.audioMs,
          speechMs: event.speechMs,
          asrMs: event.asrMs,
        });
        const { settings } = store.state;
        const category = classify(event.target, settings.cleanup.assignments);
        const decided = workFor(event.id);
        dispatch({
          type: "transcript",
          id: event.id,
          text: event.text,
          cleanup:
            decided?.kind === "style"
              ? { kind: "style", style: cleanupStyleFor(category, settings.cleanup.styles) }
              : decided,
          destination: event.target && { bundleId: event.target.bundleId, category },
          rewrites: {
            dictionary: settings.dictionary,
            snippets: settings.snippets,
          },
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
        store.update((s) =>
          s.permissions.microphone === event.microphone &&
          s.permissions.accessibility === event.accessibility
            ? s
            : {
                ...s,
                permissions: { microphone: event.microphone, accessibility: event.accessibility },
              },
        );
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

/**
 * Returns a request that runs `show` now, or once the current session or transform run reaches
 * its outcome. Showing a window mid-session would take focus from the target app and fail the
 * insertion.
 */
export function whenIdle(store: Store, show: () => void): () => void {
  let pending = false;
  store.subscribe((state) => {
    if (!pending || activity(state) !== "idle") return;
    pending = false;
    show();
  });
  return () => {
    if (activity(store.state) !== "idle") pending = true;
    else show();
  };
}

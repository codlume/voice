import { randomUUID } from "node:crypto";

import type { CleanupStyle } from "@voice/cleanup/style";
import { countWords } from "@voice/cleanup/words";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import type { Outcome, Settings } from "../shared/api.ts";
import {
  supportsCleanup,
  wantsCleanup,
  type DictationLanguage,
} from "../shared/dictation-language.ts";
import type { Output } from "../shared/rewrite.ts";
import { classify, cleanupStyleFor } from "../shared/style.ts";
import {
  BUILT_IN_TRANSFORMS,
  POLISH_ID,
  autoAppliedTransform,
  type LastTransform,
  type TransformId,
} from "../shared/transforms.ts";
import { activity } from "./activity.ts";
import type { Cleanup } from "./cleanup.ts";
import { errorType, isHelperLog, type DiagnosticLog, type Log } from "./diagnostics-scrub.ts";
import type { History } from "./history.ts";
import type { AsrSessionState, HelperCommand, HelperEvent, InsertRoute } from "./protocol.ts";
import {
  INSERT_TIMEOUT_MS,
  step,
  type Command,
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
// A cached speech model loads in about a second. Past this, macOS is compiling it for the Neural
// Engine, which takes about 30 s once per model folder.
export const ASR_PREPARING_AFTER_MS = 2000;

export type Dictation = {
  dispatch(event: SessionEvent): void;
  onHelperEvent(event: HelperEvent): void;
};

// What a helper event reports as null is unknown here, so onHelperEvent turns it into undefined.
type Started = {
  id: string;
  language: DictationLanguage;
  pressedAt: number;
  startMs?: number | undefined;
  pressRelayMs?: number | undefined;
  releasedAt?: number | undefined;
  releaseRelayMs?: number | undefined;
  audioMs?: number | undefined;
  speechMs?: number | undefined;
  asrMs?: number | undefined;
  cleanupMs?: number | undefined;
  cleanupQueueMs?: number | undefined;
  cleanupGenerateMs?: number | undefined;
  insertStartedAt?: number | undefined;
  insertRoute?: InsertRoute | undefined;
  clipboardSaveMs?: number | undefined;
  asrState?: AsrSessionState | undefined;
};

// pressRelayMs is the part of startMs spent on the hop through main. releaseToInsertMs starts
// when main sees the release, so it leaves releaseRelayMs out.
export type SessionTimings = {
  startMs?: number | undefined;
  pressRelayMs?: number | undefined;
  audioMs?: number | undefined;
  releaseRelayMs?: number | undefined;
  asrMs?: number | undefined;
  cleanupMs?: number | undefined;
  cleanupQueueMs?: number | undefined;
  cleanupGenerateMs?: number | undefined;
  insertMs?: number | undefined;
  clipboardSaveMs?: number | undefined;
  releaseToInsertMs?: number | undefined;
};

// Carries no text, session id, or target: this is what diagnostics may see of a session.
export type SessionReport = {
  outcome: Outcome;
  finishedAt: number;
  capture: {
    language: DictationLanguage;
    pressedAt: number;
    timings: SessionTimings;
    insertRoute?: InsertRoute | undefined;
    asrState?: AsrSessionState | undefined;
  } | null;
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

const outputVolumeScale = (settings: Settings) =>
  settings.lowerAudioWhileDictating ? (100 - settings.lowerAudioByPercent) / 100 : null;

function sessionTimings(s: Started, outcome: Outcome["kind"], finishedAt: number): SessionTimings {
  return {
    startMs: s.startMs,
    pressRelayMs: s.pressRelayMs,
    audioMs: s.audioMs,
    releaseRelayMs: s.releaseRelayMs,
    asrMs: s.asrMs,
    cleanupMs: s.cleanupMs,
    cleanupQueueMs: s.cleanupQueueMs,
    cleanupGenerateMs: s.cleanupGenerateMs,
    insertMs: s.insertStartedAt === undefined ? undefined : finishedAt - s.insertStartedAt,
    clipboardSaveMs: s.clipboardSaveMs,
    releaseToInsertMs:
      s.releasedAt === undefined || outcome !== "inserted" ? undefined : finishedAt - s.releasedAt,
  };
}

export function createDictation(options: DictationOptions): Dictation {
  const { store, send, cleanup, log } = options;
  const now = options.now ?? Date.now;
  let idleTimer: NodeJS.Timeout | null = null;
  let asrPreparingTimer: NodeJS.Timeout | null = null;
  let started: Started | null = null;

  function track(id: string, patch: Partial<Omit<Started, "id" | "language" | "pressedAt">>) {
    if (started?.id === id) Object.assign(started, patch);
  }
  let watchdog: NodeJS.Timeout | null = null;
  let cleaning: { id: string; fiber: Fiber.Fiber<void> } | null = null;

  function workFor(id: string): Work {
    if (started?.id !== id) return null;
    const { settings } = store.state;
    const transform = autoAppliedTransform(settings.transforms);
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
    // The helper is waiting on the commands, so they go out before the store update, whose
    // subscribers publish the snapshot to both windows and move the pill. send() never dispatches
    // back.
    for (const effect of effects) if (effect.type === "send") toHelper(effect.command);
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
    for (const effect of effects) if (effect.type !== "send") run(effect);
    if (state.phase === "done" && (before.phase !== "done" || before.id !== state.id)) {
      finish(state.id, state.outcome);
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

  function toHelper(command: Command) {
    switch (command.type) {
      case "capture.start":
        if (idleTimer) clearTimeout(idleTimer);
        started = {
          id: command.id,
          language: store.state.settings.dictationLanguage,
          pressedAt: now(),
        };
        send({
          type: "capture.start",
          id: command.id,
          language: started.language,
          outputVolumeScale: outputVolumeScale(store.state.settings),
          microphone: store.state.settings.microphone,
          detectHost: wantsCleanup(store.state.settings),
          hotkeyUptimeMs: command.hotkeyUptimeMs,
        });
        if (workFor(command.id)?.kind === "transform") options.transform.model.warm();
        return;
      case "capture.stop":
        track(command.id, { releasedAt: command.releasedAt });
        send({ type: "capture.stop", id: command.id, hotkeyUptimeMs: command.hotkeyUptimeMs });
        return;
      case "capture.cancel":
        send({ type: "capture.cancel", id: command.id });
        return;
      case "insert":
        track(command.id, { insertStartedAt: now() });
        send({
          type: "insert",
          id: command.id,
          text: command.output.text,
          html: command.output.html,
        });
        return;
    }
  }

  function run(effect: Exclude<SessionEffect, { type: "send" }>) {
    switch (effect.type) {
      case "cancelCleanup":
        if (cleaning?.id === effect.id) Effect.runFork(Fiber.interrupt(cleaning.fiber));
        return;
      case "cleanup": {
        const { id, raw, work } = effect;
        const startedAt = now();
        const budgetMs = work.kind === "style" ? cleanupBudgetMs(raw) : autoApplyBudgetMs(raw);
        const fiber = Effect.runFork(
          Effect.tryPromise({
            try: (signal) =>
              work.kind === "style"
                ? clean(id, raw, work.style, budgetMs, signal)
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
        cleaning = { id, fiber };
        return;
      }
      case "keepTransform": {
        const { items } = store.state.settings.transforms;
        options.transform.remember({
          name: items.find((item) => item.id === effect.transformId)?.name ?? "Transform",
          before: effect.before,
          after: effect.after,
        });
        return;
      }
      case "remember":
        options.history.remember(
          { id: effect.id, raw: effect.raw, text: effect.text, status: effect.status },
          now(),
        );
        return;
      case "copy":
        options.copy(effect.output);
        return;
      case "dictated": {
        const s = started?.id === effect.id ? started : null;
        options.onDictated({
          raw: effect.raw,
          insertedCleanup: effect.insertedCleanup,
          dictionaryFixes: effect.dictionaryFixes,
          language: s?.language ?? "auto",
          paceMs: s?.speechMs ?? s?.audioMs ?? null,
          finishedAt: now(),
          destination: effect.destination,
        });
        return;
      }
      case "scheduleIdle":
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => dispatch({ type: "idleTimeout", id: effect.id }), effect.ms);
        return;
    }
  }

  async function clean(
    id: string,
    raw: string,
    style: CleanupStyle,
    budgetMs: number,
    signal: AbortSignal,
  ): Promise<string> {
    const { text, chunks, cleaned, queueMs, generateMs } = await cleanup.clean(raw, style, {
      budgetMs,
      signal,
    });
    track(id, { cleanupQueueMs: queueMs, cleanupGenerateMs: generateMs });
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

  async function applyTransform(
    raw: string,
    transformId: TransformId,
    budgetMs: number,
    signal: AbortSignal,
  ): Promise<string> {
    const transform = store.state.settings.transforms.items.find((item) => item.id === transformId);
    if (!transform) throw new Error("the auto-apply transform was removed");
    const result = await options.transform.model
      .run({
        instruction: transform.instruction,
        text: raw,
        dictation: {
          // The guard's lost-opening check was measured on the stock Polish instruction (#312).
          instructionKeepsWords: BUILT_IN_TRANSFORMS.some(
            (builtIn) => builtIn.id === POLISH_ID && builtIn.instruction === transform.instruction,
          ),
        },
        budgetMs,
        signal,
      })
      .catch((error: unknown) => {
        // The worker's message is not ours to repeat in the log; the type is enough.
        throw Object.assign(new Error("transform failed"), { name: errorType(error) });
      });
    if (!result.ok) throw new Error(`transform ${result.failure.kind}`);
    return result.text;
  }

  function finish(id: string, outcome: Outcome) {
    const s = started?.id === id ? started : null;
    const finishedAt = now();
    const capture = s && {
      language: s.language,
      pressedAt: s.pressedAt,
      timings: sessionTimings(s, outcome.kind, finishedAt),
      insertRoute: s.insertRoute,
      asrState: s.asrState,
    };
    log(
      timingLine("session", id, outcome.kind, {
        ...capture?.timings,
        insertRoute: capture?.insertRoute,
        asrState: capture?.asrState,
      }),
    );
    options.onSessionDone({ outcome, finishedAt, capture });
    options.history.settle(id, outcome.kind === "inserted");
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
        if (
          (event.action === "down" || event.action === "toggle") &&
          activity(store.state) === "transform"
        ) {
          return;
        }
        const hotkeyUptimeMs = event.uptimeMs ?? undefined;
        switch (event.action) {
          case "down":
            return dispatch({ type: "hotkeyDown", id: randomUUID(), asr, hotkeyUptimeMs });
          case "toggle":
            return dispatch({ type: "toggle", id: randomUUID(), asr, hotkeyUptimeMs });
          case "up":
            return dispatch({ type: "hotkeyUp", hotkeyUptimeMs });
          case "chord":
            return dispatch({ type: "hotkeyChord" });
          case "cancel":
            return dispatch({ type: "cancel" });
        }
        return;
      }
      case "capture.started":
        track(event.id, {
          startMs: event.startMs,
          pressRelayMs: event.relayMs ?? undefined,
          asrState: event.asrState ?? undefined,
        });
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
          speechMs: event.speechMs ?? undefined,
          asrMs: event.asrMs,
          releaseRelayMs: event.relayMs ?? undefined,
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
          copyToClipboard: settings.copyToClipboard,
        });
        return;
      }
      case "transcript.failed":
        dispatch({ type: "transcriptFailed", id: event.id, message: event.message });
        return;
      case "insert.result":
        switch (event.method) {
          case "accessibility":
            track(event.id, { insertRoute: event.route ?? undefined });
            break;
          case "paste":
            track(event.id, {
              insertRoute: event.route ?? undefined,
              clipboardSaveMs: event.clipboardSaveMs ?? undefined,
            });
            break;
          case "none":
            break;
        }
        dispatch({
          type: "insertResult",
          id: event.id,
          method: event.method,
          reason: event.method === "none" ? event.reason : null,
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
          s.permissions.accessibility === event.accessibility &&
          s.permissions.systemAudio === event.systemAudio
            ? s
            : {
                ...s,
                permissions: {
                  microphone: event.microphone,
                  accessibility: event.accessibility,
                  systemAudio: event.systemAudio,
                },
              },
        );
        return;
      case "asr.status":
        if (event.state !== "loading" && asrPreparingTimer) {
          clearTimeout(asrPreparingTimer);
          asrPreparingTimer = null;
        }
        if (event.state === "loading" && store.state.models.asr.state === "loading") return;
        if (event.state === "loading") {
          asrPreparingTimer = setTimeout(() => {
            asrPreparingTimer = null;
            if (store.state.models.asr.state !== "loading") return;
            store.update((s) => ({
              ...s,
              models: { ...s.models, asr: { state: "loading", preparing: true } },
            }));
          }, ASR_PREPARING_AFTER_MS);
        }
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

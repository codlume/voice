// The transform effect runner. Owns what the reducer must not: timers, the engine call, helper
// commands and the in-memory Last transform. Mirrors dictation.ts in shape (dispatch -> step ->
// run effects) and lives in its own module so neither runner models the other's states.
import { randomUUID } from "node:crypto";

import type { TransformOutcome } from "../shared/api.ts";
import { countWords, type LastTransform, type TransformId } from "../shared/transforms.ts";
import { activity } from "./activity.ts";
import { INSERT_TIMEOUT_MS } from "./dictation.ts";
import type { Log } from "./diagnostics-scrub.ts";
import type { HelperCommand, HelperEvent } from "./protocol.ts";
import { dictating } from "./session.ts";
import type { AppState, Store } from "./store.ts";
import type { TransformModel } from "./transform-model.ts";
import {
  GENERATE_GRACE_MS,
  READ_TIMEOUT_MS,
  generateBudgetMs,
  step,
  type SelectionVia,
  type TransformEffect,
  type TransformEvent,
  type TransformRun,
} from "./transform-run.ts";

export type TransformsOptions = {
  store: Store;
  send: (command: HelperCommand) => void;
  model: Pick<TransformModel, "run" | "warm">;
  /** Writes plain text to the system clipboard. Only the Last transform panel's Copy buttons reach it. */
  copy: (text: string) => void;
  onLastTransform: (value: LastTransform | null) => void;
  log: Log;
  now?: () => number;
};

export type Transforms = {
  onHelperEvent(event: HelperEvent): void;
  dispatch(event: TransformEvent): void;
  lastTransform(): LastTransform | null;
  copyLastTransform(which: "before" | "after"): void;
  /** Auto-apply after dictation records its run here too, with the raw transcript as `before`. */
  remember(value: Omit<LastTransform, "finishedAt">): void;
  /** Forgets Last transform. Called when Transforms are turned off. */
  clearLast(): void;
  /** Aborts the engine call of a run in flight. Called on shutdown. */
  dispose(): void;
};

export const NO_LAST_TRANSFORM_MESSAGE = "There is no last transform to copy.";
const ABORTED = new Error("Transform cancelled");

// What the log line reports of a run: times and a word count, never text or the transform's name.
type Active = {
  id: string;
  controller: AbortController;
  budgetMs?: number;
  via?: SelectionVia;
  words?: number;
  readStartedAt?: number;
  readMs?: number;
  generateMs?: number;
  insertStartedAt?: number;
};

export function createTransforms(options: TransformsOptions): Transforms {
  const { store, send, model, log } = options;
  const now = options.now ?? Date.now;
  let active: Active | null = null;
  let last: LastTransform | null = null;
  let watchdog: NodeJS.Timeout | null = null;
  let idleTimer: NodeJS.Timeout | null = null;

  const transformById = (id: TransformId) =>
    store.state.settings.transforms.items.find((item) => item.id === id);

  function track(id: string, patch: Partial<Omit<Active, "id" | "controller">>) {
    if (active?.id === id) Object.assign(active, patch);
  }

  function dispatch(event: TransformEvent) {
    const before = store.state.transform;
    const { state, effects } = step(before, event, now());
    if (state !== before) {
      store.update((s) => ({ ...s, transform: state }));
      if (state.phase !== before.phase) armWatchdog(state);
    }
    for (const effect of effects) run(effect);
    if (state.phase === "done" && (before.phase !== "done" || before.id !== state.id)) {
      finish(state.id, state.outcome.kind);
    }
  }

  function armWatchdog(state: TransformRun) {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    if (state.phase === "idle" || state.phase === "done") return;
    const { id, phase } = state;
    const arm = (ms: number) => {
      watchdog = setTimeout(() => dispatch({ type: "timedOut", id, phase }), ms);
    };
    if (phase === "reading") arm(READ_TIMEOUT_MS);
    // While the model loads the run waits on the load, which has its own bound in the model, so
    // the generation watchdog starts once the model is ready (see the subscription below). The
    // phase changes before the generate effect sets the budget, so that effect arms it again.
    else if (phase === "generating") {
      const budgetMs = active?.id === id ? active.budgetMs : undefined;
      if (store.state.models.transform.state === "ready" && budgetMs !== undefined) {
        arm(budgetMs + GENERATE_GRACE_MS);
      }
    } else arm(INSERT_TIMEOUT_MS);
  }

  store.subscribe((state, previous) => {
    const current = state.transform;
    if (
      current.phase === "generating" &&
      state.models.transform.state === "ready" &&
      previous.models.transform.state !== "ready"
    ) {
      armWatchdog(current);
    }
    // A dictation that starts over a finished run takes the pill; the stale outcome must not
    // come back once the dictation ends.
    if (current.phase === "done" && dictating(state.session) && !dictating(previous.session)) {
      dispatch({ type: "idleTimeout", id: current.id });
    }
  });

  function generate(effect: Extract<TransformEffect, { type: "generate" }>) {
    const { id } = effect;
    const transform = transformById(effect.transformId);
    if (!transform) {
      dispatch({ type: "generateFailed", id, failure: { kind: "error", message: "removed" } });
      return;
    }
    const controller = new AbortController();
    const words = countWords(effect.text);
    const budgetMs = generateBudgetMs(words);
    const startedAt = now();
    track(id, { words, budgetMs });
    if (active?.id === id) active.controller = controller;
    armWatchdog(store.state.transform);
    model
      .run({
        instruction: transform.instruction,
        text: effect.text,
        dictation: false,
        budgetMs,
        signal: controller.signal,
      })
      .then(
        (result) => {
          track(id, { generateMs: now() - startedAt });
          if (result.ok) {
            dispatch({ type: "generated", id, before: effect.text, text: result.text });
          } else {
            dispatch({ type: "generateFailed", id, failure: result.failure });
          }
        },
        (error: unknown) => {
          // The reducer already moved on; the abort is its own doing.
          if (controller.signal.aborted) return;
          const message = error instanceof Error ? error.message : String(error);
          dispatch({ type: "generateFailed", id, failure: { kind: "error", message } });
        },
      );
  }

  function run(effect: TransformEffect) {
    switch (effect.type) {
      case "readSelection":
        if (idleTimer) clearTimeout(idleTimer);
        active = { id: effect.id, controller: new AbortController(), readStartedAt: now() };
        model.warm();
        send({ type: "selection.read", id: effect.id });
        return;
      case "generate":
        generate(effect);
        return;
      case "keep":
        setLast({
          name: transformById(effect.transformId)?.name ?? "Transform",
          before: effect.before,
          after: effect.after,
        });
        return;
      case "insert":
        track(effect.id, { insertStartedAt: now() });
        send({ type: "insert", id: effect.id, text: effect.text, html: null });
        return;
      case "endRun":
        if (active?.id === effect.id) active.controller.abort(ABORTED);
        send({ type: "transform.end", id: effect.id });
        return;
      case "scheduleIdle":
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => dispatch({ type: "idleTimeout", id: effect.id }), effect.ms);
        return;
    }
  }

  function finish(id: string, outcome: TransformOutcome["kind"]) {
    const a = active?.id === id ? active : null;
    const finishedAt = now();
    const timings = {
      readMs: a?.readMs,
      generateMs: a?.generateMs,
      insertMs: a?.insertStartedAt === undefined ? undefined : finishedAt - a.insertStartedAt,
      words: a?.words,
    };
    const parts = Object.entries(timings).flatMap(([key, value]) =>
      value === undefined ? [] : [`${key}=${Math.round(value)}`],
    );
    const via = a?.via === undefined ? [] : [`via=${a.via}`];
    log(`transform ${id.slice(0, 8)} outcome=${outcome} ${[...via, ...parts].join(" ")}`);
  }

  function setLast(value: Omit<LastTransform, "finishedAt"> | null) {
    last = value && { ...value, finishedAt: now() };
    options.onLastTransform(last);
  }

  function onHelperEvent(event: HelperEvent) {
    switch (event.type) {
      case "transform": {
        const { transforms } = store.state.settings;
        const transform = transforms.items.find((item) => item.id === event.transformId);
        if (!transforms.enabled || !transform) return;
        if (activity(store.state) !== "idle") return;
        dispatch({
          type: "shortcut",
          id: randomUUID(),
          transformId: transform.id,
          model: store.state.models.transform,
        });
        return;
      }
      case "selection.result": {
        if (active?.readStartedAt !== undefined) {
          track(event.id, { readMs: now() - active.readStartedAt });
        }
        if (event.outcome === "selected") {
          track(event.id, { via: event.via });
          dispatch({ type: "selected", id: event.id, text: event.text, via: event.via });
        } else {
          dispatch({ type: "selectionFailed", id: event.id, failure: event.reason });
        }
        return;
      }
      case "insert.result":
        dispatch({
          type: "insertResult",
          id: event.id,
          method: event.method,
          reason: event.reason,
        });
        return;
      case "hotkey":
        if (event.action === "cancel") dispatch({ type: "cancel" });
        return;
      default:
        return;
    }
  }

  return {
    onHelperEvent,
    dispatch,
    lastTransform: () => last,
    copyLastTransform: (which) => {
      if (!last) throw new Error(NO_LAST_TRANSFORM_MESSAGE);
      options.copy(last[which]);
    },
    remember: setLast,
    clearLast: () => setLast(null),
    dispose: () => {
      if (watchdog) clearTimeout(watchdog);
      if (idleTimer) clearTimeout(idleTimer);
      active?.controller.abort(ABORTED);
    },
  };
}

/**
 * A settings change moves the transform model, as `followSettings` does for cleanup. Turning
 * Transforms on downloads the model once if it is missing. Turning them off forgets Last transform
 * and frees the memory; a run in flight finishes, only what is kept for later goes.
 */
export function followTransformSettings(
  model: Pick<TransformModel, "onDisk" | "install" | "unload">,
  transforms: Pick<Transforms, "clearLast">,
  state: AppState,
  previous: AppState,
) {
  const enabled = state.settings.transforms.enabled;
  if (enabled === previous.settings.transforms.enabled) return;
  if (enabled) {
    if (!model.onDisk()) void model.install();
  } else {
    transforms.clearLast();
    void model.unload();
  }
}

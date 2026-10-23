import { randomUUID } from "node:crypto";

import type { TransformOutcome } from "../shared/api.ts";
import type { LastTransform, TransformId } from "../shared/transforms.ts";
import { activity } from "./activity.ts";
import type { Log } from "./diagnostics-scrub.ts";
import type { HelperCommand, HelperEvent } from "./protocol.ts";
import { INSERT_TIMEOUT_MS, dictating } from "./session.ts";
import type { AppState, Store } from "./store.ts";
import { timingLine } from "./timing.ts";
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
  model: Pick<TransformModel, "run">;
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
  remember(value: Omit<LastTransform, "finishedAt">): void;
  clearLast(): void;
  dispose(): void;
};

export const NO_LAST_TRANSFORM_MESSAGE = "There is no last transform to copy.";
const ABORTED = new Error("Transform cancelled");

type Active = {
  id: string;
  controller: AbortController;
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
    const { state, effects } = step(before, event);
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
    else if (phase === "generating") {
      if (store.state.models.transform.state === "ready") {
        arm(generateBudgetMs(state.words) + GENERATE_GRACE_MS);
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
    if (current.phase === "done" && dictating(state.session) && !dictating(previous.session)) {
      dispatch({ type: "idleTimeout", id: current.id });
    }
  });

  function generate(effect: Extract<TransformEffect, { type: "generate" }>) {
    const { id } = effect;
    const transform = transformById(effect.transformId);
    if (!transform) {
      dispatch({ type: "generateFailed", id, failure: { kind: "error" } });
      return;
    }
    const controller = new AbortController();
    const budgetMs = generateBudgetMs(effect.words);
    const startedAt = now();
    track(id, { words: effect.words });
    if (active?.id === id) active.controller = controller;
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
        () => {
          if (controller.signal.aborted) return;
          dispatch({ type: "generateFailed", id, failure: { kind: "error" } });
        },
      );
  }

  function run(effect: TransformEffect) {
    switch (effect.type) {
      case "readSelection":
        if (idleTimer) clearTimeout(idleTimer);
        active = { id: effect.id, controller: new AbortController(), readStartedAt: now() };
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
    log(
      timingLine("transform", id, outcome, {
        via: a?.via,
        readMs: a?.readMs,
        generateMs: a?.generateMs,
        insertMs: a?.insertStartedAt === undefined ? undefined : finishedAt - a.insertStartedAt,
        words: a?.words,
      }),
    );
  }

  function setLast(value: Omit<LastTransform, "finishedAt"> | null) {
    // A run that outlives the switch-off, or dictation's auto-apply, must not leave text behind.
    if (value && !store.state.settings.transforms.enabled) return;
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

export function followTransformSettings(
  model: Pick<TransformModel, "onDisk" | "install" | "unload">,
  transforms: Pick<Transforms, "dispatch" | "clearLast">,
  state: AppState,
  previous: AppState,
) {
  const enabled = state.settings.transforms.enabled;
  if (enabled === previous.settings.transforms.enabled) return;
  if (enabled) {
    if (!model.onDisk()) void model.install();
  } else {
    transforms.dispatch({ type: "cancel" });
    transforms.clearLast();
    void model.unload();
  }
}

import { describe, expect, test } from "vite-plus/test";

import type { ModelStatus, SelectionFailure, TransformOutcome } from "../shared/api.ts";
import type { TransformId } from "../shared/transforms.ts";
import {
  HELPER_EXITED_MESSAGE,
  HELPER_TIMEOUT_MESSAGE,
  IDLE_AFTER_INSERTED_MS,
  IDLE_AFTER_OTHER_MS,
} from "./session.ts";
import {
  ENGINE_STOPPED_MESSAGE,
  REJECTED_MESSAGE,
  SELECTION_FAILED_MESSAGE,
  TIMED_OUT_MESSAGE,
  idleRun,
  step,
  toPillState,
  type GenerateFailure,
  type TransformEvent,
  type TransformRun,
} from "./transform-run.ts";

const polish = "polish" as TransformId;
const ready: ModelStatus = { state: "ready" };
const shortcut = (id = "r1", model: ModelStatus = ready): TransformEvent => ({
  type: "shortcut",
  id,
  transformId: polish,
  model,
});

const reading: TransformRun = { phase: "reading", id: "r1", transformId: polish };
const generating: TransformRun = {
  phase: "generating",
  id: "r1",
  transformId: polish,
  via: "accessibility",
  words: 3,
};
const inserting: TransformRun = { phase: "inserting", id: "r1" };
const done = (outcome: TransformOutcome): TransformRun => ({ phase: "done", id: "r1", outcome });

const ending = (outcome: TransformOutcome) => {
  const quick = outcome.kind === "inserted" || outcome.kind === "cancelled";
  return {
    state: done(outcome),
    effects: [
      { type: "endRun", id: "r1" },
      { type: "scheduleIdle", id: "r1", ms: quick ? IDLE_AFTER_INSERTED_MS : IDLE_AFTER_OTHER_MS },
    ],
  };
};

describe("transform run", () => {
  test("happy path: shortcut reads, selection generates, result keeps then inserts, insert ends", () => {
    const read = step(idleRun, shortcut());
    expect(read).toEqual({ state: reading, effects: [{ type: "readSelection", id: "r1" }] });

    const generate = step(read.state, {
      type: "selected",
      id: "r1",
      text: "so um hello",
      via: "accessibility",
    });
    expect(generate).toEqual({
      state: generating,
      effects: [{ type: "generate", id: "r1", transformId: polish, text: "so um hello", words: 3 }],
    });

    const insert = step(generate.state, {
      type: "generated",
      id: "r1",
      before: "so um hello",
      text: "Hello.",
    });
    expect(insert).toEqual({
      state: inserting,
      effects: [
        { type: "keep", transformId: polish, before: "so um hello", after: "Hello." },
        { type: "insert", id: "r1", text: "Hello." },
      ],
    });

    const end = step(insert.state, {
      type: "insertResult",
      id: "r1",
      method: "paste",
      reason: null,
    });
    expect(end).toEqual(ending({ kind: "inserted", method: "paste" }));
    expect(step(end.state, { type: "idleTimeout", id: "r1" })).toEqual({
      state: idleRun,
      effects: [],
    });
  });

  test("the run state never holds the selection or the result", () => {
    const text = "SENTINEL-before";
    const result = "SENTINEL-after";
    let run = step(idleRun, shortcut()).state;
    run = step(run, { type: "selected", id: "r1", text, via: "copy" }).state;
    expect(JSON.stringify(run)).not.toContain(text);
    run = step(run, { type: "generated", id: "r1", before: text, text: result }).state;
    expect(JSON.stringify(run)).not.toContain(text);
    expect(JSON.stringify(run)).not.toContain(result);
  });

  test.each<[SelectionFailure, TransformOutcome]>([
    ["noSelection", { kind: "noSelection" }],
    ["secureInput", { kind: "secureInput" }],
    ["noFocusedField", { kind: "noFocusedField" }],
    ["keysHeld", { kind: "keysHeld" }],
    ["failed", { kind: "failed", message: SELECTION_FAILED_MESSAGE }],
  ])("a selection read that fails with %s ends the run as %j", (failure, outcome) => {
    expect(step(reading, { type: "selectionFailed", id: "r1", failure })).toEqual(ending(outcome));
  });

  test.each<[GenerateFailure, TransformOutcome]>([
    [
      { kind: "tooLong", maxWords: 640 },
      { kind: "tooLong", maxWords: 640 },
    ],
    [{ kind: "timedOut" }, { kind: "failed", message: TIMED_OUT_MESSAGE }],
    [{ kind: "rejected" }, { kind: "failed", message: REJECTED_MESSAGE }],
    [{ kind: "error" }, { kind: "failed", message: ENGINE_STOPPED_MESSAGE }],
  ])("a generation that fails with %j ends the run as %j", (failure, outcome) => {
    expect(step(generating, { type: "generateFailed", id: "r1", failure })).toEqual(
      ending(outcome),
    );
  });

  test.each<[ModelStatus, TransformOutcome]>([
    [{ state: "missing" }, { kind: "modelUnavailable", state: "missing" }],
    [
      { state: "failed", message: "boom" },
      { kind: "modelUnavailable", state: "failed" },
    ],
    [{ state: "downloading" }, { kind: "modelUnavailable", state: "downloading" }],
    [
      { state: "downloading", progress: 0.4 },
      { kind: "modelUnavailable", state: "downloading", progress: 0.4 },
    ],
  ])("a shortcut with the model %j ends at once as %j without reading", (model, outcome) => {
    const result = step(idleRun, shortcut("r1", model));
    expect(result).toEqual(ending(outcome));
    expect(result.effects.map((e) => e.type)).not.toContain("readSelection");
  });

  test.each<ModelStatus>([{ state: "installed" }, { state: "loading" }, { state: "ready" }])(
    "a shortcut with the model %j starts reading",
    (model) => {
      expect(step(idleRun, shortcut("r1", model)).state).toEqual(reading);
    },
  );

  test("Escape cancels while reading or generating, and is ignored once the write started", () => {
    expect(step(reading, { type: "cancel" })).toEqual(ending({ kind: "cancelled" }));
    expect(step(generating, { type: "cancel" })).toEqual(ending({ kind: "cancelled" }));
    expect(step(inserting, { type: "cancel" })).toEqual({ state: inserting, effects: [] });
    const finished = done({ kind: "noSelection" });
    expect(step(finished, { type: "cancel" })).toEqual({ state: finished, effects: [] });
  });

  test("a write refused because the target changed ends notInserted after keep was emitted", () => {
    const kept = step(generating, { type: "generated", id: "r1", before: "draft", text: "Draft." });
    expect(kept.effects[0]).toEqual({
      type: "keep",
      transformId: polish,
      before: "draft",
      after: "Draft.",
    });
    expect(
      step(kept.state, {
        type: "insertResult",
        id: "r1",
        method: "none",
        reason: "selectionChanged",
      }),
    ).toEqual(ending({ kind: "notInserted", reason: "selectionChanged" }));
  });

  test("a write that fails without a reason reads as failed", () => {
    expect(
      step(inserting, { type: "insertResult", id: "r1", method: "none", reason: null }),
    ).toEqual(ending({ kind: "notInserted", reason: "failed" }));
  });

  test("events for another run id change nothing", () => {
    const stale: TransformEvent[] = [
      { type: "selected", id: "r0", text: "x", via: "copy" },
      { type: "selectionFailed", id: "r0", failure: "noSelection" },
      { type: "generated", id: "r0", before: "x", text: "y" },
      { type: "generateFailed", id: "r0", failure: { kind: "rejected" } },
      { type: "insertResult", id: "r0", method: "paste", reason: null },
      { type: "timedOut", id: "r0", phase: "reading" },
      { type: "idleTimeout", id: "r0" },
    ];
    for (const state of [reading, generating, inserting, done({ kind: "cancelled" })]) {
      for (const event of stale) expect(step(state, event)).toEqual({ state, effects: [] });
    }
    for (const event of stale)
      expect(step(idleRun, event)).toEqual({ state: idleRun, effects: [] });
  });

  test("a second shortcut mid-run is ignored, and one after done starts a new run", () => {
    for (const state of [reading, generating, inserting]) {
      expect(step(state, shortcut("r2"))).toEqual({ state, effects: [] });
    }
    expect(step(done({ kind: "inserted", method: "paste" }), shortcut("r2"))).toEqual({
      state: { phase: "reading", id: "r2", transformId: polish },
      effects: [{ type: "readSelection", id: "r2" }],
    });
  });

  test("a helper exit fails the run, or reports the write unconfirmed once it started", () => {
    const exited = { kind: "failed", message: HELPER_EXITED_MESSAGE } as const;
    expect(step(reading, { type: "helperExited" })).toEqual(ending(exited));
    expect(step(generating, { type: "helperExited" })).toEqual(ending(exited));
    expect(step(inserting, { type: "helperExited" })).toEqual(
      ending({ kind: "notInserted", reason: "failed" }),
    );
    expect(step(idleRun, { type: "helperExited" })).toEqual({ state: idleRun, effects: [] });
  });

  test("each phase's watchdog ends the run, and a watchdog from an earlier phase is ignored", () => {
    expect(step(reading, { type: "timedOut", id: "r1", phase: "reading" })).toEqual(
      ending({ kind: "failed", message: HELPER_TIMEOUT_MESSAGE }),
    );
    expect(step(generating, { type: "timedOut", id: "r1", phase: "generating" })).toEqual(
      ending({ kind: "failed", message: TIMED_OUT_MESSAGE }),
    );
    expect(step(inserting, { type: "timedOut", id: "r1", phase: "inserting" })).toEqual(
      ending({ kind: "notInserted", reason: "failed" }),
    );
    expect(step(generating, { type: "timedOut", id: "r1", phase: "reading" })).toEqual({
      state: generating,
      effects: [],
    });
  });

  // Every (state, event) pair that reaches done. The helper keeps Escape and the target shelf
  // until transform.end, so a path that forgets endRun leaves Escape swallowed system-wide.
  const intoDone: [string, TransformRun, TransformEvent][] = [
    ["shortcut, model missing", idleRun, shortcut("r1", { state: "missing" })],
    ["selectionFailed", reading, { type: "selectionFailed", id: "r1", failure: "keysHeld" }],
    [
      "generateFailed",
      generating,
      { type: "generateFailed", id: "r1", failure: { kind: "rejected" } },
    ],
    [
      "insertResult",
      inserting,
      { type: "insertResult", id: "r1", method: "accessibility", reason: null },
    ],
    ["cancel while reading", reading, { type: "cancel" }],
    ["cancel while generating", generating, { type: "cancel" }],
    ["helperExited while reading", reading, { type: "helperExited" }],
    ["helperExited while generating", generating, { type: "helperExited" }],
    ["helperExited while inserting", inserting, { type: "helperExited" }],
    ["timedOut while reading", reading, { type: "timedOut", id: "r1", phase: "reading" }],
    ["timedOut while generating", generating, { type: "timedOut", id: "r1", phase: "generating" }],
    ["timedOut while inserting", inserting, { type: "timedOut", id: "r1", phase: "inserting" }],
  ];

  test.each(intoDone)("%s ends the helper's run too", (_name, state, event) => {
    const { state: next, effects } = step(state, event);
    expect(next.phase).toBe("done");
    expect(effects).toContainEqual({ type: "endRun", id: "r1" });
  });

  test("nothing else emits endRun, so the helper sees one end per run", () => {
    const stays: [TransformRun, TransformEvent][] = [
      [idleRun, shortcut()],
      [reading, { type: "selected", id: "r1", text: "x", via: "copy" }],
      [generating, { type: "generated", id: "r1", before: "x", text: "y" }],
      [inserting, { type: "cancel" }],
      [done({ kind: "cancelled" }), { type: "idleTimeout", id: "r1" }],
    ];
    for (const [state, event] of stays) {
      expect(step(state, event).effects.map((e) => e.type)).not.toContain("endRun");
    }
  });
});

describe("toPillState", () => {
  test("yields to the dictation pill while idle", () => {
    expect(toPillState(idleRun, ready)).toBeNull();
  });

  test("shows work while reading and inserting, and names the load only while generating", () => {
    expect(toPillState(reading, { state: "installed" })).toEqual({
      kind: "transforming",
      loading: false,
    });
    expect(toPillState(generating, { state: "loading" })).toEqual({
      kind: "transforming",
      loading: true,
    });
    expect(toPillState(generating, { state: "installed" })).toEqual({
      kind: "transforming",
      loading: true,
    });
    expect(toPillState(generating, ready)).toEqual({ kind: "transforming", loading: false });
    expect(toPillState(inserting, { state: "loading" })).toEqual({
      kind: "transforming",
      loading: false,
    });
  });

  test("carries the outcome once done", () => {
    expect(toPillState(done({ kind: "tooLong", maxWords: 900 }), ready)).toEqual({
      kind: "transformDone",
      outcome: { kind: "tooLong", maxWords: 900 },
    });
  });
});

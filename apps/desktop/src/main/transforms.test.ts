import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { DEFAULT_SETTINGS, type ModelStatus } from "../shared/api.ts";
import {
  DEFAULT_TRANSFORMS,
  POLISH_ID,
  type LastTransform,
  type TransformSettings,
} from "../shared/transforms.ts";
import { INSERT_TIMEOUT_MS } from "./dictation.ts";
import type { HelperCommand, HelperEvent } from "./protocol.ts";
import { HELPER_TIMEOUT_MESSAGE, idle, type Session } from "./session.ts";
import { createStore, toSnapshot } from "./store.ts";
import type { TransformRequest, TransformResult } from "./transform-model.ts";
import {
  GENERATE_GRACE_MS,
  READ_TIMEOUT_MS,
  TIMED_OUT_MESSAGE,
  generateBudgetMs,
  idleRun,
} from "./transform-run.ts";
import { NO_LAST_TRANSFORM_MESSAGE, createTransforms } from "./transforms.ts";

type Selection =
  | { outcome: "selected"; text: string; via?: "accessibility" | "copy" }
  | {
      outcome: "failed";
      reason: "noSelection" | "secureInput" | "noFocusedField" | "keysHeld" | "failed";
    };

type Options = {
  transforms?: Partial<TransformSettings>;
  model?: ModelStatus;
  selection?: Selection;
  insertReason?: "selectionChanged" | "focusChanged" | null;
  insertNeverAnswers?: boolean;
  selectionNeverAnswers?: boolean;
  copyToClipboard?: boolean;
  session?: Session;
};

const SELECTED = "SENTINEL-SELECTION so um the launch moved to friday";
const RESULT = "SENTINEL-RESULT The launch moved to Friday.";

// The transform run id is minted by randomUUID, so the harness reads it back from the first
// helper command of the run, the way the fake helper would.
function harness(opts: Options = {}) {
  const store = createStore({
    updates: {
      version: "0.0.1",
      installedChannel: "stable",
      channel: "stable",
      status: { kind: "disabled", reason: "Test" },
    },
    session: opts.session ?? idle,
    transform: idleRun,
    permissions: { microphone: "granted", accessibility: "granted" },
    loginItem: "off",
    models: {
      asr: { state: "ready" },
      cleanup: { state: "ready" },
      transform: opts.model ?? { state: "ready" },
    },
    settings: {
      ...DEFAULT_SETTINGS,
      copyToClipboard: opts.copyToClipboard ?? false,
      transforms: { ...DEFAULT_TRANSFORMS, enabled: true, ...opts.transforms },
    },
    microphones: { kind: "loading" },
    microphoneTest: { kind: "off" },
    account: { kind: "signedOut" },
  });
  const commands: HelperCommand[] = [];
  const logs: string[] = [];
  const copies: string[] = [];
  const lasts: (LastTransform | null)[] = [];
  const kinds: string[] = [];
  const runs: {
    request: TransformRequest;
    resolve(result: TransformResult): void;
    reject(e: unknown): void;
  }[] = [];
  let warms = 0;
  store.subscribe((state) => kinds.push(toSnapshot(state).session.kind));
  const transforms = createTransforms({
    store,
    send: (command) => {
      commands.push(command);
      if (command.type === "selection.read" && !opts.selectionNeverAnswers) {
        const selection = opts.selection ?? { outcome: "selected", text: SELECTED };
        setTimeout(() => {
          transforms.onHelperEvent(
            selection.outcome === "selected"
              ? {
                  type: "selection.result",
                  id: command.id,
                  outcome: "selected",
                  text: selection.text,
                  via: selection.via ?? "accessibility",
                }
              : { type: "selection.result", id: command.id, ...selection },
          );
        }, 10);
      }
      if (command.type === "insert" && !opts.insertNeverAnswers) {
        const reason = opts.insertReason ?? null;
        setTimeout(() => {
          transforms.onHelperEvent({
            type: "insert.result",
            id: command.id,
            method: reason === null ? "accessibility" : "none",
            reason,
          });
        }, 10);
      }
    },
    model: {
      warm: () => {
        warms += 1;
      },
      run: (request) =>
        new Promise<TransformResult>((resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          });
          runs.push({ request, resolve, reject });
        }),
    },
    copy: (text) => copies.push(text),
    onLastTransform: (value) => lasts.push(value),
    log: (message) => logs.push(message),
  });
  const of = <T extends HelperCommand["type"]>(type: T) =>
    commands.filter((c): c is Extract<HelperCommand, { type: T }> => c.type === type);
  const press = (transformId: string = POLISH_ID) =>
    transforms.onHelperEvent({ type: "transform", transformId });
  const event = (e: HelperEvent) => transforms.onHelperEvent(e);
  return {
    store,
    transforms,
    commands,
    logs,
    copies,
    lasts,
    kinds,
    runs,
    of,
    press,
    event,
    warms: () => warms,
  };
}

const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

/** Presses the shortcut and lets the selection come back, so the engine call is in flight. */
async function startGenerating(h: ReturnType<typeof harness>) {
  h.press();
  await flush(10);
  expect(h.runs).toHaveLength(1);
  return h.runs[0]!;
}

describe("createTransforms", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("a shortcut reads the selection, runs the model, inserts under the same id, then ends the run", async () => {
    const h = harness();
    const run = await startGenerating(h);
    expect(h.of("selection.read")).toHaveLength(1);
    const id = h.of("selection.read")[0]!.id;
    expect(run.request).toMatchObject({
      instruction: DEFAULT_TRANSFORMS.items[0]!.instruction,
      text: SELECTED,
      dictation: false,
      budgetMs: generateBudgetMs(8),
    });
    expect(h.warms()).toBe(1);

    run.resolve({ ok: true, text: RESULT });
    await flush(10);

    expect(h.commands.map((c) => c.type)).toEqual(["selection.read", "insert", "transform.end"]);
    expect(h.of("insert")[0]).toEqual({ type: "insert", id, text: RESULT, html: null });
    expect(h.of("transform.end")[0]).toEqual({ type: "transform.end", id });
    expect(h.store.state.transform).toEqual({
      phase: "done",
      id,
      outcome: { kind: "inserted", method: "accessibility" },
    });
    expect(h.kinds).toEqual(["transforming", "transforming", "transforming", "transformDone"]);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatch(
      new RegExp(
        `^transform ${id.slice(0, 8)} outcome=inserted via=accessibility readMs=\\d+ generateMs=\\d+ insertMs=\\d+ words=8$`,
      ),
    );
  });

  test("the selection, the instruction and the result reach no log line", async () => {
    const h = harness({
      transforms: {
        items: [{ ...DEFAULT_TRANSFORMS.items[0]!, instruction: "SENTINEL-INSTRUCTION polish" }],
      },
    });
    const run = await startGenerating(h);
    run.resolve({ ok: true, text: RESULT });
    await flush(10);

    const all = h.logs.join("\n");
    for (const secret of ["SENTINEL-SELECTION", "SENTINEL-INSTRUCTION", "SENTINEL-RESULT"]) {
      expect(all).not.toContain(secret);
    }
    expect(JSON.stringify(h.store.state.transform)).not.toContain("SENTINEL");
  });

  test("an engine failure inserts nothing but still ends the run", async () => {
    const h = harness();
    const run = await startGenerating(h);
    run.resolve({ ok: false, failure: { kind: "tooLong", maxWords: 640 } });
    await flush();

    expect(h.of("insert")).toEqual([]);
    expect(h.of("transform.end")).toHaveLength(1);
    expect(h.store.state.transform).toMatchObject({
      phase: "done",
      outcome: { kind: "tooLong", maxWords: 640 },
    });
    expect(h.logs[0]).toContain("outcome=tooLong");
  });

  test("an engine crash reads as a fixed sentence, and its message reaches no log", async () => {
    const h = harness();
    const run = await startGenerating(h);
    run.reject(new Error("SENTINEL-CRASH llama_decode failed"));
    await flush();

    expect(h.store.state.transform).toMatchObject({
      phase: "done",
      outcome: { kind: "failed", message: "The transform model stopped. Text unchanged" },
    });
    expect(h.logs.join("\n")).not.toContain("SENTINEL-CRASH");
    expect(h.of("transform.end")).toHaveLength(1);
  });

  test("Escape while generating aborts the engine call, inserts nothing and ends the run", async () => {
    const h = harness();
    const run = await startGenerating(h);

    h.event({ type: "hotkey", action: "cancel" });
    await flush();

    expect(run.request.signal.aborted).toBe(true);
    expect(h.store.state.transform).toMatchObject({
      phase: "done",
      outcome: { kind: "cancelled" },
    });
    expect(h.of("transform.end")).toHaveLength(1);
    // A result that arrives after the cancel is dropped.
    run.resolve({ ok: true, text: RESULT });
    await flush(10);
    expect(h.of("insert")).toEqual([]);
    expect(h.lasts).toEqual([]);
  });

  test("Escape once the write started changes nothing", async () => {
    const h = harness({ insertNeverAnswers: true });
    const run = await startGenerating(h);
    run.resolve({ ok: true, text: RESULT });
    await flush();
    expect(h.store.state.transform.phase).toBe("inserting");

    h.event({ type: "hotkey", action: "cancel" });

    expect(h.store.state.transform.phase).toBe("inserting");
    expect(h.of("transform.end")).toEqual([]);
  });

  test("a transform never writes the clipboard on its own, whatever the dictation setting says", async () => {
    const h = harness({ copyToClipboard: true });
    const run = await startGenerating(h);
    run.resolve({ ok: true, text: RESULT });
    await flush(10);

    expect(h.store.state.transform).toMatchObject({ outcome: { kind: "inserted" } });
    expect(h.copies).toEqual([]);
  });

  test.each<[string, Options]>([
    ["Transforms are off", { transforms: { enabled: false } }],
    ["the id is unknown", { transforms: { items: [] } }],
    [
      "a dictation is recording",
      { session: { phase: "recording", id: "s1", mode: "hold", pressedAt: 0 } },
    ],
  ])("a shortcut is ignored when %s", (_name, opts) => {
    const h = harness(opts);
    h.press();
    expect(h.commands).toEqual([]);
    expect(h.store.state.transform).toEqual(idleRun);
  });

  test("a second shortcut mid-run is dropped, and one after the outcome starts a new run", async () => {
    const h = harness();
    await startGenerating(h);
    h.press();
    expect(h.of("selection.read")).toHaveLength(1);

    h.runs[0]!.resolve({ ok: true, text: RESULT });
    await flush(10);
    h.press();

    expect(h.of("selection.read")).toHaveLength(2);
  });

  test.each<[ModelStatus, string]>([
    [{ state: "missing" }, "missing"],
    [{ state: "downloading", progress: 0.2 }, "downloading"],
    [{ state: "failed", message: "x" }, "failed"],
  ])("with the model %j the run ends at once, without a read or a load", (model, state) => {
    const h = harness({ model });
    h.press();

    expect(h.of("selection.read")).toEqual([]);
    expect(h.warms()).toBe(0);
    expect(h.store.state.transform).toMatchObject({
      phase: "done",
      outcome: { kind: "modelUnavailable", state },
    });
    expect(h.of("transform.end")).toHaveLength(1);
  });

  test.each([
    ["noSelection", "noSelection"],
    ["keysHeld", "keysHeld"],
    ["failed", "failed"],
  ] as const)(
    "a selection read that fails with %s ends the run without the model",
    async (reason, kind) => {
      const h = harness({ selection: { outcome: "failed", reason } });
      h.press();
      await flush(10);

      expect(h.runs).toEqual([]);
      expect(h.store.state.transform).toMatchObject({ phase: "done", outcome: { kind } });
      expect(h.of("transform.end")).toHaveLength(1);
      expect(h.logs[0]).toMatch(/^transform \w{8} outcome=\w+ readMs=\d+$/);
    },
  );

  test("Last transform is kept before the write, so a refused write still offers the original", async () => {
    const h = harness({ insertReason: "selectionChanged" });
    const run = await startGenerating(h);
    expect(h.transforms.lastTransform()).toBeNull();
    expect(() => h.transforms.copyLastTransform("before")).toThrow(NO_LAST_TRANSFORM_MESSAGE);

    run.resolve({ ok: true, text: RESULT });
    await flush();
    const kept = h.transforms.lastTransform();
    expect(kept).toEqual({
      name: "Polish",
      before: SELECTED,
      after: RESULT,
      finishedAt: Date.now(),
    });
    expect(h.lasts).toEqual([kept]);
    await flush(10);

    expect(h.store.state.transform).toMatchObject({
      outcome: { kind: "notInserted", reason: "selectionChanged" },
    });
    expect(h.transforms.lastTransform()).toEqual(kept);
    h.transforms.copyLastTransform("before");
    h.transforms.copyLastTransform("after");
    expect(h.copies).toEqual([SELECTED, RESULT]);

    h.transforms.clearLast();
    expect(h.transforms.lastTransform()).toBeNull();
    expect(h.lasts.at(-1)).toBeNull();
  });

  test("remember records a run made elsewhere, with the time it was recorded", () => {
    const h = harness();
    vi.setSystemTime(1_000);
    h.transforms.remember({ name: "Polish", before: "raw words", after: "Raw words." });
    expect(h.transforms.lastTransform()).toEqual({
      name: "Polish",
      before: "raw words",
      after: "Raw words.",
      finishedAt: 1_000,
    });
    expect(h.lasts).toHaveLength(1);
  });

  test("a helper exit mid-run fails it and still tells the next helper the run is over", async () => {
    const h = harness();
    await startGenerating(h);

    h.transforms.dispatch({ type: "helperExited" });

    expect(h.store.state.transform).toMatchObject({
      phase: "done",
      outcome: { kind: "failed", message: "Voice helper stopped" },
    });
    expect(h.of("transform.end")).toHaveLength(1);
    expect(h.runs[0]!.request.signal.aborted).toBe(true);
  });

  test("a selection read that never answers times out and ends the run", async () => {
    const h = harness({ selectionNeverAnswers: true });
    h.press();
    await flush(READ_TIMEOUT_MS - 1);
    expect(h.store.state.transform.phase).toBe("reading");

    await flush(1);

    expect(h.store.state.transform).toMatchObject({
      phase: "done",
      outcome: { kind: "failed", message: HELPER_TIMEOUT_MESSAGE },
    });
    expect(h.runs).toEqual([]);
    expect(h.of("transform.end")).toHaveLength(1);
  });

  test("the generation watchdog waits for the model to load, then runs from the budget", async () => {
    const h = harness({ model: { state: "installed" } });
    await startGenerating(h);
    const budget = generateBudgetMs(8) + GENERATE_GRACE_MS;

    h.store.update((s) => ({ ...s, models: { ...s.models, transform: { state: "loading" } } }));
    await flush(budget * 2);
    expect(h.store.state.transform.phase).toBe("generating");

    h.store.update((s) => ({ ...s, models: { ...s.models, transform: { state: "ready" } } }));
    await flush(budget - 1);
    expect(h.store.state.transform.phase).toBe("generating");
    await flush(1);

    expect(h.store.state.transform).toMatchObject({
      phase: "done",
      outcome: { kind: "failed", message: TIMED_OUT_MESSAGE },
    });
    expect(h.runs[0]!.request.signal.aborted).toBe(true);
    expect(h.of("insert")).toEqual([]);
  });

  test("with the model already loaded, the generation watchdog runs from the budget", async () => {
    const h = harness({ model: { state: "ready" } });
    const run = await startGenerating(h);
    const budget = generateBudgetMs(8) + GENERATE_GRACE_MS;

    await flush(budget - 1);
    expect(h.store.state.transform.phase).toBe("generating");
    await flush(1);

    expect(h.store.state.transform).toMatchObject({
      phase: "done",
      outcome: { kind: "failed", message: TIMED_OUT_MESSAGE },
    });
    expect(run.request.signal.aborted).toBe(true);
  });

  test("a write the helper never confirms times out as not inserted", async () => {
    const h = harness({ insertNeverAnswers: true });
    const run = await startGenerating(h);
    run.resolve({ ok: true, text: RESULT });
    await flush();

    await flush(INSERT_TIMEOUT_MS);

    expect(h.store.state.transform).toMatchObject({
      outcome: { kind: "notInserted", reason: "failed" },
    });
    expect(h.transforms.lastTransform()?.after).toBe(RESULT);
  });

  test("the outcome leaves the pill on its own, and sooner when a dictation starts over it", async () => {
    const h = harness();
    const run = await startGenerating(h);
    run.resolve({ ok: true, text: RESULT });
    await flush(10);
    expect(toSnapshot(h.store.state).session.kind).toBe("transformDone");

    h.store.update((s) => ({
      ...s,
      session: { phase: "starting", id: "s1", mode: "hold", pressedAt: 0, releasedAt: null },
    }));

    expect(h.store.state.transform).toEqual(idleRun);
  });
});

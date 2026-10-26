import { MessageChannel, type MessagePort } from "node:worker_threads";

import type { TransformEngine, TransformRequest, TransformResult } from "@voice/cleanup/transform";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { ModelStatus } from "../shared/api.ts";
import { createTransformProcess, serve } from "./transform-engine.ts";
import {
  createTransformModel,
  IDLE_UNLOAD_MS,
  LOAD_TIMEOUT_MS,
  type TransformModule,
} from "./transform-model.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const RESULT: TransformResult = { ok: true, text: "Polished." };
const MODEL_PATH = "/models/gemma.gguf";

type Run = { request: Omit<TransformRequest, "signal">; finish(result: TransformResult): void };

// One utility process: the real serve loop and process client over a MessageChannel, around a
// fake engine.
type FakeWorker = {
  modelPath: string;
  loads: number;
  disposes: number;
  runs: Run[];
  closed: boolean;
  crash(): void;
};

const request = (overrides: Partial<TransformRequest> = {}): TransformRequest => ({
  instruction: "Polish this text.",
  text: "so um the launch moved to friday",
  dictation: false,
  budgetMs: 30_000,
  signal: new AbortController().signal,
  ...overrides,
});

const ports: MessagePort[] = [];
afterEach(() => {
  for (const port of ports.splice(0)) port.close();
  vi.useRealTimers();
});

function harness({
  onDisk = true,
  holdLoad = false,
  holdRuns = false,
  loadError = undefined as string | undefined,
} = {}) {
  const statuses: ModelStatus[] = [];
  const workers: FakeWorker[] = [];
  const disk = { present: onDisk, downloads: 0, removes: 0 };
  let loadGate = holdLoad ? deferred() : undefined;
  const runStarted: (() => void)[] = [];

  const module: TransformModule = {
    source: {
      baseUrl: "https://example.invalid/model",
      file: "gemma.gguf",
      bytes: 1,
      sha256: "0".repeat(64),
      legal: [],
    },
    findModel: async () => (disk.present ? MODEL_PATH : undefined),
    downloadModel: async ({ onProgress }) => {
      disk.downloads += 1;
      onProgress?.(0.5);
      disk.present = true;
      return MODEL_PATH;
    },
    removeModel: async () => {
      disk.present = false;
      disk.removes += 1;
    },
    createProcess: ({ modelPath, onLost }) => {
      const { port1, port2 } = new MessageChannel();
      ports.push(port1, port2);
      const worker: FakeWorker = {
        modelPath,
        loads: 0,
        disposes: 0,
        runs: [],
        closed: false,
        crash: () => port2.close(),
      };
      port1.on("close", () => (worker.closed = true));
      workers.push(worker);
      const engine: TransformEngine = {
        load: async () => {
          worker.loads += 1;
          await loadGate?.promise;
          if (loadError) throw new Error(loadError);
        },
        transform: ({ signal, ...received }) =>
          new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason));
            worker.runs.push({ request: received, finish: resolve });
            runStarted.shift()?.();
            if (!holdRuns) resolve(RESULT);
          }),
        dispose: async () => {
          worker.disposes += 1;
        },
      };
      serve(
        {
          on: (_event, listener) => port2.on("message", (data: unknown) => listener({ data })),
          postMessage: (message) => port2.postMessage(message),
        },
        () => engine,
      );
      return createTransformProcess({
        modelPath,
        onLost,
        fork: (events) => {
          port1.on("message", events.message);
          port1.on("close", events.exit);
          return {
            postMessage: (message) => port1.postMessage(message),
            kill: () => port1.close(),
          };
        },
      });
    },
  };

  const model = createTransformModel({
    modelsDir: "/models",
    onStatus: (status) => statuses.push(status),
    log: () => {},
    loadModule: async () => module,
  });

  return {
    model,
    statuses,
    workers,
    disk,
    release: () => {
      loadGate?.resolve();
      loadGate = undefined;
    },
    nextRun: () => new Promise<void>((resolve) => runStarted.push(resolve)),
    last: () => statuses.at(-1),
  };
}

const idleTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

describe("transform model", () => {
  test("a launch check reports installed and starts no process", async () => {
    const { model, statuses, workers } = harness();

    await model.refresh();

    expect(statuses).toEqual([{ state: "installed" }]);
    expect(model.onDisk()).toBe(true);
    expect(workers).toEqual([]);
  });

  test("a launch check without weights reports missing, and a run rejects without a process", async () => {
    const { model, statuses, workers } = harness({ onDisk: false });

    await model.refresh();

    expect(statuses).toEqual([{ state: "missing" }]);
    await expect(model.run(request())).rejects.toThrow("not installed");
    expect(workers).toEqual([]);
  });

  test("install downloads with progress and reports installed without loading", async () => {
    const { model, statuses, workers } = harness({ onDisk: false });
    await model.refresh();

    await model.install();

    expect(statuses).toEqual([
      { state: "missing" },
      { state: "downloading", progress: 0 },
      { state: "downloading", progress: 0.5 },
      { state: "installed" },
    ]);
    expect(model.onDisk()).toBe(true);
    expect(workers).toEqual([]);
  });

  test("the first run loads the model, then the request crosses to the engine and its result comes back", async () => {
    const { model, statuses, workers } = harness();
    await model.refresh();

    const result = await model.run(request({ dictation: { instructionKeepsWords: true } }));

    expect(result).toEqual(RESULT);
    expect(statuses).toEqual([{ state: "installed" }, { state: "loading" }, { state: "ready" }]);
    expect(workers).toHaveLength(1);
    expect(workers[0]?.modelPath).toBe(MODEL_PATH);
    expect(workers[0]?.runs[0]?.request).toMatchObject({
      instruction: "Polish this text.",
      text: "so um the launch moved to friday",
      dictation: { instructionKeepsWords: true },
    });
  });

  test("warm loads once however often it is called, and a run reuses that process", async () => {
    const { model, workers, last } = harness();
    await model.refresh();

    model.warm();
    model.warm();
    await model.run(request());

    expect(workers).toHaveLength(1);
    expect(workers[0]?.loads).toBe(1);
    expect(last()).toEqual({ state: "ready" });
  });

  test("a load, however long, leaves the run's whole budget for generation", async () => {
    idleTimers();
    const { model, workers, release } = harness({ holdLoad: true });
    await model.refresh();

    const running = model.run(request({ budgetMs: 10_000 }));
    await vi.waitFor(() => expect(workers[0]?.loads).toBe(1));
    // Three times the budget, and vi.waitFor moved the fake clock some more.
    vi.advanceTimersByTime(30_000);
    release();

    await expect(running).resolves.toEqual(RESULT);
    expect(workers[0]?.runs[0]?.request.budgetMs).toBe(10_000);
  });

  test("a load past its bound ends the run timed out, stops the process and leaves the model installed", async () => {
    idleTimers();
    const { model, workers, last } = harness({ holdLoad: true });
    await model.refresh();

    const running = model.run(request({ budgetMs: 10_000 }));
    await vi.waitFor(() => expect(workers[0]?.loads).toBe(1));
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);

    await expect(running).resolves.toEqual({ ok: false, failure: { kind: "timedOut" } });
    await vi.waitFor(() => expect(workers[0]?.closed).toBe(true));
    expect(workers[0]?.runs).toEqual([]);
    expect(last()).toEqual({ state: "installed" });
  });

  test("unload stops an idle process and reports installed, but leaves a run in flight alone", async () => {
    const { model, workers, nextRun, last } = harness({ holdRuns: true });
    await model.refresh();
    const started = nextRun();
    const running = model.run(request());
    await started;

    await model.unload();
    expect(workers[0]?.closed).toBe(false);
    workers[0]?.runs[0]?.finish(RESULT);
    await expect(running).resolves.toEqual(RESULT);

    await model.unload();

    await vi.waitFor(() => expect(workers[0]?.closed).toBe(true));
    expect(last()).toEqual({ state: "installed" });
    const again = nextRun();
    const next = model.run(request());
    await again;
    workers[1]?.runs[0]?.finish(RESULT);
    await expect(next).resolves.toEqual(RESULT);
    expect(workers).toHaveLength(2);
  });

  test("an unload asked for while a cancelled run settles stops the process once it has", async () => {
    const { model, workers, nextRun, last } = harness({ holdRuns: true });
    await model.refresh();
    const controller = new AbortController();
    const started = nextRun();
    const running = model.run(request({ signal: controller.signal }));
    await started;

    controller.abort(new Error("Transform cancelled"));
    await model.unload();
    await expect(running).rejects.toThrow("Transform cancelled");

    await vi.waitFor(() => expect(workers[0]?.closed).toBe(true));
    expect(last()).toEqual({ state: "installed" });
  });

  test("a run that starts after a deferred unload keeps the process", async () => {
    idleTimers();
    const { model, workers, nextRun } = harness({ holdRuns: true });
    await model.refresh();
    const started = nextRun();
    const first = model.run(request());
    await started;
    await model.unload();

    const secondStarted = nextRun();
    const second = model.run(request());
    await secondStarted;
    workers[0]?.runs[0]?.finish(RESULT);
    await first;
    workers[0]?.runs[1]?.finish(RESULT);
    await second;

    await vi.advanceTimersByTimeAsync(IDLE_UNLOAD_MS - 1);
    expect(workers[0]?.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(workers[0]?.closed).toBe(true));
  });

  test("a warm-up after a deferred unload keeps the process", async () => {
    idleTimers();
    const { model, workers, nextRun } = harness({ holdRuns: true });
    await model.refresh();
    const started = nextRun();
    const first = model.run(request());
    await started;
    await model.unload();

    model.warm();
    workers[0]?.runs[0]?.finish(RESULT);
    await first;

    await vi.advanceTimersByTimeAsync(IDLE_UNLOAD_MS - 1);
    expect(workers[0]?.closed).toBe(false);
  });

  test("the process is killed after the idle wait, and the next run loads a new one", async () => {
    idleTimers();
    const { model, workers, last } = harness();
    await model.refresh();
    await model.run(request());

    await vi.advanceTimersByTimeAsync(IDLE_UNLOAD_MS - 1);
    expect(workers[0]?.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await vi.waitFor(() => expect(workers[0]?.closed).toBe(true));
    expect(workers[0]?.disposes).toBe(1);
    expect(last()).toEqual({ state: "installed" });

    await model.run(request());
    expect(workers).toHaveLength(2);
    expect(last()).toEqual({ state: "ready" });
  });

  test("each run starts the idle wait over, and a run in flight is never unloaded", async () => {
    idleTimers();
    const { model, workers, nextRun } = harness({ holdRuns: true });
    await model.refresh();

    const started = nextRun();
    const first = model.run(request());
    await started;
    // A warm while the run is in flight, then ten minutes into the run.
    model.warm();
    await vi.advanceTimersByTimeAsync(2 * IDLE_UNLOAD_MS);
    expect(workers[0]?.closed).toBe(false);
    workers[0]?.runs[0]?.finish(RESULT);
    await first;

    await vi.advanceTimersByTimeAsync(IDLE_UNLOAD_MS - 60_000);
    const secondStarted = nextRun();
    const second = model.run(request());
    await secondStarted;
    workers[0]?.runs[1]?.finish(RESULT);
    await second;
    await vi.advanceTimersByTimeAsync(IDLE_UNLOAD_MS - 1);
    expect(workers[0]?.closed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(workers[0]?.closed).toBe(true));
  });

  test("a lost process rejects its run and leaves the model installed; install does not download again, and the next run loads again", async () => {
    const { model, workers, disk, nextRun, statuses, last } = harness({ holdRuns: true });
    await model.refresh();
    const started = nextRun();
    const running = model.run(request());
    await started;

    workers[0]?.crash();

    await expect(running).rejects.toThrow("The transform model stopped unexpectedly.");
    expect(last()).toEqual({ state: "installed" });
    await model.install();
    expect(disk.downloads).toBe(0);
    statuses.length = 0;

    const again = nextRun();
    const next = model.run(request());
    await again;
    workers[1]?.runs[0]?.finish(RESULT);
    await expect(next).resolves.toEqual(RESULT);
    expect(statuses).toEqual([{ state: "loading" }, { state: "ready" }]);
  });

  test("a load failure rejects the run and leaves the model installed; install does not download again", async () => {
    const { model, workers, disk, statuses } = harness({ loadError: "Metal out of memory" });
    await model.refresh();

    await expect(model.run(request())).rejects.toThrow("Metal out of memory");
    await model.install();

    expect(disk.downloads).toBe(0);
    await vi.waitFor(() => expect(workers[0]?.closed).toBe(true));
    expect(statuses).toEqual([
      { state: "installed" },
      { state: "loading" },
      { state: "installed" },
    ]);
  });

  test("uninstall during a load stops the process, removes the weights and ends missing", async () => {
    const { model, workers, disk, statuses } = harness({ holdLoad: true });
    await model.refresh();
    const running = model.run(request());
    const rejected = expect(running).rejects.toThrow();
    await vi.waitFor(() => expect(workers[0]?.loads).toBe(1));

    await model.uninstall();

    await rejected;
    await vi.waitFor(() => expect(workers[0]?.closed).toBe(true));
    expect(disk.removes).toBe(1);
    expect(model.onDisk()).toBe(false);
    expect(statuses).toEqual([{ state: "installed" }, { state: "loading" }, { state: "missing" }]);
    await expect(model.run(request())).rejects.toThrow("not installed");
  });

  test("a run withdrawn while the model loads rejects with the reason, and the load carries on", async () => {
    const { model, workers, release, last } = harness({ holdLoad: true });
    await model.refresh();
    const controller = new AbortController();
    const running = model.run(request({ signal: controller.signal }));
    await vi.waitFor(() => expect(workers[0]?.loads).toBe(1));
    const reason = new Error("cancelled");

    controller.abort(reason);

    await expect(running).rejects.toBe(reason);
    release();
    await vi.waitFor(() => expect(last()).toEqual({ state: "ready" }));
    expect(workers[0]?.runs).toEqual([]);
  });

  test("dispose stops the process without reporting it lost", async () => {
    const { model, workers, statuses } = harness();
    await model.refresh();
    await model.run(request());
    const before = statuses.length;

    await model.dispose();

    await vi.waitFor(() => expect(workers[0]?.closed).toBe(true));
    expect(statuses).toHaveLength(before);
  });
});

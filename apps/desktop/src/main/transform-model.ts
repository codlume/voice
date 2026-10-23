// The transform model's lifecycle in main: install, find, load on use, idle unload, status.
// Unlike the cleanup model it is not kept loaded: it holds about 3.45 GB of Metal memory, so it
// loads on the first run or warm and its process is killed after 5 idle minutes.
import type { TransformEngine, TransformRequest, TransformResult } from "@voice/cleanup/transform";
import type { ModelSource } from "@voice/cleanup/download";

import type { ModelStatus } from "../shared/api.ts";
import { forkUtility } from "./engine-process.ts";
import { createTransformProcess } from "./transform-engine.ts";

export type { TransformFailure, TransformRequest, TransformResult } from "@voice/cleanup/transform";

/**
 * `run` resolves with data for every failure the text caused and rejects only on abort
 * (`signal.reason`), a model that is not installed, a load failure or a lost process.
 */
export type TransformModel = {
  /** Launch check: finds weights on disk and reports installed or missing. Never loads. */
  refresh(): Promise<void>;
  install(): Promise<void>;
  uninstall(): Promise<void>;
  /**
   * Loads on demand. The load has its own bound (`LOAD_TIMEOUT_MS`), and the budget counts from
   * the moment the engine is ready, so a cold start never eats the generation time.
   */
  run(request: TransformRequest): Promise<TransformResult>;
  /** Fire and forget. Starts a load if the weights are on disk. Safe to call on every press. */
  warm(): void;
  /** Frees the Metal memory now. A run in flight keeps its process; the idle unload follows it. */
  unload(): Promise<void>;
  onDisk(): boolean;
  dispose(): Promise<void>;
};

export const IDLE_UNLOAD_MS = 5 * 60_000;
// A first-ever load measured 28.6 s in Electron; three times that is a stuck process.
export const LOAD_TIMEOUT_MS = 90_000;

export type TransformModule = Pick<
  typeof import("@voice/cleanup/download"),
  "downloadModel" | "findModel" | "removeModel"
> & {
  source: ModelSource;
  createProcess(options: { modelPath: string; onLost: (message: string) => void }): TransformEngine;
};

export type TransformModelOptions = {
  modelsDir: string;
  // Test mode serves the weights from a local server.
  baseUrl?: string | undefined;
  onStatus: (status: ModelStatus) => void;
  log: (message: string) => void;
  loadModule?: () => Promise<TransformModule>;
};

async function importModule(log: (message: string) => void): Promise<TransformModule> {
  const [{ downloadModel, findModel, removeModel }, { TRANSFORM_MODEL }, { utilityProcess }] =
    await Promise.all([
      import("@voice/cleanup/download"),
      import("@voice/cleanup/transform"),
      import("electron"),
    ]);
  const fork = forkUtility(utilityProcess, {
    entry: "transform-engine-worker.cjs",
    serviceName: "Voice transforms",
    tag: "transform",
    log,
  });
  return {
    downloadModel,
    findModel,
    removeModel,
    source: TRANSFORM_MODEL.source,
    createProcess: (options) => createTransformProcess({ ...options, fork }),
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const TIMED_OUT: TransformResult = { ok: false, failure: { kind: "timedOut" } };

type Resident = { path: string; engine: TransformEngine; loaded: Promise<void> };

type Phase =
  // failure: why the last download or removal did not finish.
  | { phase: "missing"; failure?: string }
  | { phase: "downloading"; progress: number; controller: AbortController; done: Promise<void> }
  // A lost process, a failed load or an idle unload all come back here, so the next run reloads
  // from the weights already on disk.
  | { phase: "installed"; path: string }
  | ({ phase: "loading" | "ready" } & Resident)
  // Uninstall reports the removal's outcome when it ends.
  | { phase: "removing" }
  | { phase: "disposed" };

function statusOf(state: Phase): ModelStatus | undefined {
  switch (state.phase) {
    case "missing":
      return state.failure === undefined
        ? { state: "missing" }
        : { state: "failed", message: state.failure };
    case "downloading":
      return { state: "downloading", progress: state.progress };
    case "installed":
    case "loading":
    case "ready":
      return { state: state.phase };
    case "removing":
    case "disposed":
      return undefined;
  }
}

const resident = (state: Phase): state is Extract<Phase, Resident> =>
  state.phase === "loading" || state.phase === "ready";

// Resolves undefined once the load overruns LOAD_TIMEOUT_MS, and rejects with the signal's reason
// if the run is withdrawn first.
async function withinLoadBound(
  loading: Promise<TransformEngine>,
  signal: AbortSignal,
): Promise<TransformEngine | undefined> {
  let timer: NodeJS.Timeout | undefined;
  let withdraw: (() => void) | undefined;
  try {
    return await Promise.race([
      loading,
      new Promise<undefined>((resolve, reject) => {
        timer = setTimeout(() => resolve(undefined), LOAD_TIMEOUT_MS);
        withdraw = () => reject(signal.reason);
        signal.addEventListener("abort", withdraw, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (withdraw) signal.removeEventListener("abort", withdraw);
  }
}

export function createTransformModel(options: TransformModelOptions): TransformModel {
  let module: Promise<TransformModule> | undefined;
  const loadModule = () => (module ??= (options.loadModule ?? (() => importModule(options.log)))());
  let state: Phase = { phase: "missing" };
  // Residency, apart from the phase: runs in flight and the idle unload that follows the last.
  let running = 0;
  let idleTimer: NodeJS.Timeout | undefined;

  const owns = (engine: TransformEngine) => resident(state) && state.engine === engine;

  // The one place the phase changes. Leaving a loading or ready phase frees its engine.
  function set(next: Phase): Promise<void> {
    const previous = state;
    state = next;
    const status = statusOf(next);
    if (status) options.onStatus(status);
    if (!resident(previous) || (resident(next) && next.engine === previous.engine)) {
      return Promise.resolve();
    }
    clearTimeout(idleTimer);
    return previous.engine.dispose();
  }

  // Idle means no run in flight for IDLE_UNLOAD_MS. A run clears the timer and arms it again when
  // it ends, so a long run is never unloaded under itself.
  function armIdle() {
    clearTimeout(idleTimer);
    if (running > 0 || state.phase === "disposed") return;
    idleTimer = setTimeout(() => {
      if (resident(state)) void set({ phase: "installed", path: state.path });
    }, IDLE_UNLOAD_MS);
  }

  function start(path: string, createProcess: TransformModule["createProcess"]) {
    const engine = createProcess({
      modelPath: path,
      onLost: (lostMessage) => {
        if (!owns(engine)) return;
        options.log(`transform: ${lostMessage}`);
        void set({ phase: "installed", path });
      },
    });
    const loaded = engine.load();
    void set({ phase: "loading", path, engine, loaded });
    loaded.then(
      () => {
        if (owns(engine)) void set({ phase: "ready", path, engine, loaded });
      },
      (error: unknown) => {
        if (!owns(engine)) return;
        options.log(`transform: load failed: ${message(error)}`);
        void set({ phase: "installed", path });
      },
    );
  }

  async function loadedEngine(): Promise<TransformEngine> {
    const { createProcess } = await loadModule();
    if (state.phase === "disposed") throw new Error("Voice is closing.");
    if (state.phase === "installed") start(state.path, createProcess);
    if (!resident(state)) throw new Error("The transform model is not installed.");
    const { engine, loaded } = state;
    await loaded;
    return engine;
  }

  async function download(controller: AbortController): Promise<void> {
    try {
      const { downloadModel, source } = await loadModule();
      const path = await downloadModel({
        dir: options.modelsDir,
        source,
        baseUrl: options.baseUrl,
        onProgress: (progress) => {
          if (state.phase === "downloading" && state.controller === controller) {
            void set({ ...state, progress });
          }
        },
        signal: controller.signal,
      });
      if (!controller.signal.aborted) void set({ phase: "installed", path });
    } catch (error) {
      if (!controller.signal.aborted) void set({ phase: "missing", failure: message(error) });
    }
  }

  return {
    refresh: async () => {
      const { findModel, source } = await loadModule();
      const path = await findModel({ dir: options.modelsDir, source });
      if (state.phase !== "missing" && state.phase !== "installed") return;
      void set(path === undefined ? { phase: "missing" } : { phase: "installed", path });
    },
    // Weights already on disk are not checked again: hashing 3.1 GB is not a retry.
    install: () => {
      if (state.phase === "downloading") return state.done;
      if (state.phase !== "missing") return Promise.resolve();
      const controller = new AbortController();
      const done = download(controller);
      void set({ phase: "downloading", progress: 0, controller, done });
      return done;
    },
    uninstall: async () => {
      if (state.phase === "downloading") {
        const { controller, done } = state;
        controller.abort(new Error("Download cancelled"));
        await done;
      }
      await set({ phase: "removing" });
      const { removeModel, source } = await loadModule();
      try {
        await removeModel({ dir: options.modelsDir, source });
      } catch (error) {
        void set({ phase: "missing", failure: message(error) });
        return;
      }
      void set({ phase: "missing" });
    },
    run: async (request) => {
      request.signal.throwIfAborted();
      running += 1;
      clearTimeout(idleTimer);
      try {
        // A run withdrawn while the model loads leaves the load going for the next one. A load
        // that overruns its bound is a stuck process: it is stopped so the next run starts fresh.
        const engine = await withinLoadBound(loadedEngine(), request.signal);
        if (!engine) {
          options.log("transform: the model took too long to load");
          if (resident(state)) void set({ phase: "installed", path: state.path });
          return TIMED_OUT;
        }
        return await engine.transform(request);
      } finally {
        running -= 1;
        armIdle();
      }
    },
    warm: () => {
      if (state.phase !== "installed" && !resident(state)) return;
      loadedEngine().catch(() => undefined);
      armIdle();
    },
    unload: async () => {
      if (!resident(state) || running > 0) return;
      await set({ phase: "installed", path: state.path });
    },
    onDisk: () => state.phase === "installed" || resident(state),
    dispose: async () => {
      const previous = state;
      if (previous.phase === "downloading")
        previous.controller.abort(new Error("Voice is closing"));
      await Promise.all([
        previous.phase === "downloading" ? previous.done : undefined,
        set({ phase: "disposed" }),
      ]);
    },
  };
}

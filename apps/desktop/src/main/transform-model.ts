// The transform model's lifecycle in main: install, find, load on use, idle unload, status.
// Unlike the cleanup model it is not kept loaded: it holds about 3.45 GB of Metal memory, so it
// loads on the first run or warm and its process is killed after 5 idle minutes.
import * as NodePath from "node:path";
import { createInterface } from "node:readline";

import type { TransformEngine, TransformRequest, TransformResult } from "@voice/cleanup/transform";
import type { ModelSource } from "@voice/cleanup/download";

import type { ModelStatus } from "../shared/api.ts";
import { createTransformProcess, type ForkTransformEngine } from "./transform-engine.ts";

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
export const LOAD_TIMED_OUT_MESSAGE = "The transform model took too long to load.";

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
  const fork: ForkTransformEngine = (events) => {
    const child = utilityProcess.fork(NodePath.join(__dirname, "transform-engine-worker.cjs"), [], {
      serviceName: "Voice transforms",
      stdio: "pipe",
      execArgv: [],
    });
    child.on("message", events.message).on("exit", (code) => {
      log(`transform: exited (${code})`);
      events.exit();
    });
    for (const output of [child.stdout, child.stderr]) {
      if (output)
        createInterface({ input: output }).on("line", (line) => log(`transform: ${line}`));
    }
    return child;
  };
  return {
    downloadModel,
    findModel,
    removeModel,
    source: TRANSFORM_MODEL.source,
    createProcess: (options) => createTransformProcess({ ...options, fork }),
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type EngineWorker = { engine: TransformEngine; loaded: Promise<void>; ready: boolean };

export function createTransformModel(options: TransformModelOptions): TransformModel {
  let module: Promise<TransformModule> | undefined;
  const loadModule = () => (module ??= (options.loadModule ?? (() => importModule(options.log)))());
  // Where the weights are, once a refresh or an install found them.
  let modelPath: string | undefined;
  let worker: EngineWorker | undefined;
  let installing: { controller: AbortController; done: Promise<void> } | undefined;
  let running = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let disposed = false;

  const restingStatus = (): ModelStatus =>
    worker
      ? { state: worker.ready ? "ready" : "loading" }
      : { state: modelPath ? "installed" : "missing" };

  function stop(): Promise<void> {
    clearTimeout(idleTimer);
    const current = worker;
    worker = undefined;
    return current?.engine.dispose() ?? Promise.resolve();
  }

  // Idle means no run in flight for IDLE_UNLOAD_MS. A run clears the timer and arms it again when
  // it ends, so a long run is never unloaded under itself.
  function armIdle() {
    clearTimeout(idleTimer);
    if (running > 0 || disposed) return;
    idleTimer = setTimeout(() => {
      if (!worker) return;
      void stop();
      options.onStatus(restingStatus());
    }, IDLE_UNLOAD_MS);
  }

  async function loadedEngine(): Promise<TransformEngine> {
    const { createProcess } = await loadModule();
    if (disposed) throw new Error("Voice is closing.");
    if (!worker) {
      if (modelPath === undefined) throw new Error("The transform model is not installed.");
      const engine = createProcess({
        modelPath,
        onLost: (lostMessage) => {
          if (worker?.engine !== engine) return;
          worker = undefined;
          clearTimeout(idleTimer);
          options.onStatus({ state: "failed", message: lostMessage });
        },
      });
      const current: EngineWorker = { engine, loaded: engine.load(), ready: false };
      worker = current;
      options.onStatus({ state: "loading" });
      current.loaded.then(
        () => {
          current.ready = true;
          if (worker === current) options.onStatus({ state: "ready" });
        },
        (error: unknown) => {
          if (worker !== current) return;
          worker = undefined;
          void engine.dispose();
          options.onStatus({ state: "failed", message: message(error) });
        },
      );
    }
    const { engine, loaded } = worker;
    await loaded;
    return engine;
  }

  return {
    refresh: async () => {
      const { findModel, source } = await loadModule();
      modelPath = await findModel({ dir: options.modelsDir, source });
      if (!installing && !worker && !disposed) options.onStatus(restingStatus());
    },
    install: () => {
      if (disposed) return Promise.resolve();
      if (installing) return installing.done;
      const controller = new AbortController();
      const done = (async () => {
        options.onStatus({ state: "downloading", progress: 0 });
        try {
          const { downloadModel, source } = await loadModule();
          const path = await downloadModel({
            dir: options.modelsDir,
            source,
            baseUrl: options.baseUrl,
            onProgress: (progress) => options.onStatus({ state: "downloading", progress }),
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          modelPath = path;
          options.onStatus(restingStatus());
        } catch (error) {
          if (!controller.signal.aborted) {
            options.onStatus({ state: "failed", message: message(error) });
          }
        } finally {
          installing = undefined;
        }
      })();
      installing = { controller, done };
      return done;
    },
    uninstall: async () => {
      installing?.controller.abort(new Error("Download cancelled"));
      await installing?.done;
      modelPath = undefined;
      await stop();
      const { removeModel, source } = await loadModule();
      try {
        await removeModel({ dir: options.modelsDir, source });
      } catch (error) {
        options.onStatus({ state: "failed", message: message(error) });
        return;
      }
      options.onStatus({ state: "missing" });
    },
    run: async (request) => {
      request.signal.throwIfAborted();
      let withdraw: (() => void) | undefined;
      let loadTimer: NodeJS.Timeout | undefined;
      running += 1;
      clearTimeout(idleTimer);
      try {
        // A run withdrawn while the model loads leaves the load going for the next one. A load
        // that overruns its bound is a stuck process: it is stopped so the next run starts fresh.
        const loading = loadedEngine();
        loading.catch(() => undefined);
        const engine = await Promise.race([
          loading,
          new Promise<never>((_, reject) => {
            withdraw = () => reject(request.signal.reason);
            request.signal.addEventListener("abort", withdraw, { once: true });
          }),
          new Promise<"loadTimedOut">((resolve) => {
            loadTimer = setTimeout(resolve, LOAD_TIMEOUT_MS, "loadTimedOut");
          }),
        ]);
        if (engine === "loadTimedOut") {
          void stop();
          options.onStatus({ state: "failed", message: LOAD_TIMED_OUT_MESSAGE });
          return { ok: false, failure: { kind: "timedOut" } };
        }
        return await engine.transform(request);
      } finally {
        clearTimeout(loadTimer);
        if (withdraw) request.signal.removeEventListener("abort", withdraw);
        running -= 1;
        armIdle();
      }
    },
    warm: () => {
      if (modelPath === undefined || disposed) return;
      loadedEngine().catch(() => undefined);
      armIdle();
    },
    unload: async () => {
      if (!worker || running > 0 || disposed) return;
      await stop();
      options.onStatus(restingStatus());
    },
    onDisk: () => modelPath !== undefined,
    dispose: async () => {
      disposed = true;
      installing?.controller.abort(new Error("Voice is closing"));
      await Promise.all([installing?.done, stop()]);
    },
  };
}

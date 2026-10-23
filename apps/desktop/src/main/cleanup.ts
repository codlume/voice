import * as NodePath from "node:path";
import { createInterface } from "node:readline";

import type { CleanRequest, CleanResult, CleanupStyle } from "@voice/cleanup";
import type { ModelSource } from "@voice/cleanup/download";

import type { ModelStatus } from "../shared/api.ts";
import { wantsCleanup } from "../shared/dictation-language.ts";
import { createS1MiniProcess, type CleanupEngine, type ForkEngine } from "./cleanup-engine.ts";
import { dictating } from "./session.ts";
import type { AppState } from "./store.ts";

export type CleanupModule = Pick<
  typeof import("@voice/cleanup/download"),
  "downloadModel" | "findModel" | "removeModel"
> & {
  source: ModelSource;
  createS1Mini(options: { modelPath: string; onLost: (message: string) => void }): CleanupEngine;
};

export type Cleanup = {
  loadIfDownloaded(): Promise<void>;
  install(): Promise<void>;
  uninstall(): Promise<void>;
  unload(): Promise<void>;
  loaded(): boolean;
  // Keeps the GPU clocked up while the speech model transcribes, so the clean that follows does not
  // pay the ramp-up. letGpuIdle ends it when no clean follows.
  keepGpuBusy(): void;
  letGpuIdle(): void;
  clean(raw: string, style: CleanupStyle, request: Required<CleanRequest>): Promise<CleanResult>;
  dispose(): Promise<void>;
};

export type CleanupOptions = {
  modelsDir: string;
  baseUrl?: string | undefined;
  shouldLoad: () => boolean;
  onStatus: (status: ModelStatus) => void;
  log: (message: string) => void;
  loadModule?: () => Promise<CleanupModule>;
};

async function importModule(log: (message: string) => void): Promise<CleanupModule> {
  const [{ downloadModel, findModel, removeModel, S1_MINI }, { utilityProcess }] =
    await Promise.all([import("@voice/cleanup/download"), import("electron")]);
  const fork: ForkEngine = (events) => {
    const child = utilityProcess.fork(NodePath.join(__dirname, "cleanup-engine-worker.cjs"), [], {
      serviceName: "Voice cleanup",
      stdio: "pipe",
      execArgv: [],
    });
    child.on("message", events.message).on("exit", (code) => {
      log(`cleanup: exited (${code})`);
      events.exit();
    });
    for (const output of [child.stdout, child.stderr]) {
      if (output) createInterface({ input: output }).on("line", (line) => log(`cleanup: ${line}`));
    }
    return child;
  };
  return {
    downloadModel,
    findModel,
    removeModel,
    source: S1_MINI,
    createS1Mini: (options) => createS1MiniProcess({ ...options, fork }),
  };
}

const WARM_UP_TEXT = "um so this is a quick warm up";
const WARM_UP_STYLE: CleanupStyle = { style: "formal", layout: "general" };
// Typical transcription takes 150-250 ms. A longer one outlasts the cap and its clean starts cold.
const GPU_BUSY_MS = 1000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Model =
  | { phase: "none" }
  | { phase: "loading"; model: CleanupEngine }
  | { phase: "loaded"; model: CleanupEngine }
  // Left behind by dispose so a load or download still in flight does not bring the model back.
  | { phase: "disposed" };

const held = (model: Model): model is Extract<Model, { model: CleanupEngine }> =>
  model.phase === "loading" || model.phase === "loaded";

// A session in flight keeps the model until it ends, so a language change applies to the next
// session. The loaded check unloads a model it kept once that session is done.
export function followSettings(
  cleanup: Pick<Cleanup, "loadIfDownloaded" | "unload" | "loaded">,
  state: AppState,
  previous: AppState,
) {
  const wanted = wantsCleanup(state.settings);
  if (wanted && !wantsCleanup(previous.settings)) {
    void cleanup.loadIfDownloaded();
  } else if (
    !wanted &&
    !dictating(state.session) &&
    (wantsCleanup(previous.settings) || cleanup.loaded())
  ) {
    void cleanup.unload();
  }
}

export function createCleanup(options: CleanupOptions): Cleanup {
  const loadModule = options.loadModule ?? (() => importModule(options.log));
  let model: Model = { phase: "none" };
  let chain: Promise<void> = Promise.resolve();
  const installs = new Set<AbortController>();

  const owns = (candidate: CleanupEngine) => held(model) && model.model === candidate;

  function cancelInstalls(reason: string) {
    for (const controller of installs) controller.abort(new Error(reason));
  }

  function serialize(work: () => Promise<void>) {
    const run = chain.then(work);
    chain = run.catch(() => undefined);
    return run;
  }

  function claimIdle(): boolean {
    if (model.phase === "disposed") model = { phase: "none" };
    return model.phase === "none";
  }

  function disposeThen(work: () => Promise<void> = async () => {}) {
    const current = model;
    model = { phase: "disposed" };
    const freed = held(current) ? current.model.dispose() : Promise.resolve();
    return serialize(async () => {
      await freed;
      await work();
    });
  }

  async function loadModel(module: CleanupModule, modelPath: string) {
    if (!options.shouldLoad()) {
      options.onStatus({ state: "installed" });
      return;
    }
    if (model.phase !== "none") return;
    options.onStatus({ state: "loading" });
    let created: CleanupEngine | undefined;
    try {
      const candidate = module.createS1Mini({
        modelPath,
        onLost: (lostMessage) => {
          if (!owns(candidate)) return;
          model = { phase: "none" };
          options.onStatus({ state: "failed", message: lostMessage });
        },
      });
      created = candidate;
      model = { phase: "loading", model: created };
      await created.load();
    } catch (error) {
      if (created) {
        if (!owns(created)) return;
        model = { phase: "none" };
        await created.dispose();
      }
      options.onStatus({ state: "failed", message: message(error) });
      return;
    }
    if (!owns(created)) return;
    model = { phase: "loaded", model: created };
    await created.clean(WARM_UP_TEXT, WARM_UP_STYLE).catch(() => undefined);
    if (owns(created)) options.onStatus({ state: "ready" });
  }

  async function loadIfOnDisk() {
    if (!claimIdle()) return;
    const module = await loadModule();
    const modelPath = await module.findModel({ dir: options.modelsDir, source: module.source });
    if (modelPath === undefined) {
      options.onStatus({ state: "missing" });
      return;
    }
    await loadModel(module, modelPath);
  }

  return {
    loadIfDownloaded: () => serialize(loadIfOnDisk),
    install: () => {
      const controller = new AbortController();
      installs.add(controller);
      return serialize(async () => {
        try {
          if (controller.signal.aborted || !claimIdle()) return;
          options.onStatus({ state: "downloading", progress: 0 });
          const module = await loadModule();
          if (controller.signal.aborted) return;
          let modelPath: string;
          try {
            modelPath = await module.downloadModel({
              dir: options.modelsDir,
              source: module.source,
              baseUrl: options.baseUrl,
              onProgress: (progress) => options.onStatus({ state: "downloading", progress }),
              signal: controller.signal,
            });
          } catch (error) {
            if (!controller.signal.aborted) {
              options.onStatus({ state: "failed", message: message(error) });
            }
            return;
          }
          if (controller.signal.aborted) return;
          await loadModel(module, modelPath);
        } finally {
          installs.delete(controller);
        }
      });
    },
    uninstall: () => {
      cancelInstalls("Download cancelled");
      return disposeThen(async () => {
        const module = await loadModule();
        try {
          await module.removeModel({ dir: options.modelsDir, source: module.source });
        } catch (error) {
          options.onStatus({ state: "failed", message: message(error) });
          return;
        }
        options.onStatus({ state: "missing" });
      });
    },
    // Rerunning the startup check reports installed, or reloads if cleanup came back on meanwhile.
    unload: () => disposeThen(loadIfOnDisk),
    loaded: () => model.phase === "loaded",
    keepGpuBusy() {
      if (model.phase === "loaded") model.model.keepGpuBusy(GPU_BUSY_MS);
    },
    letGpuIdle() {
      if (model.phase === "loaded") model.model.keepGpuBusy(0);
    },
    clean(raw, style, request) {
      if (model.phase !== "loaded") return Promise.reject(new Error("cleanup model is not ready"));
      return model.model.clean(raw, style, request);
    },
    dispose: () => {
      cancelInstalls("Voice is closing");
      return disposeThen();
    },
  };
}

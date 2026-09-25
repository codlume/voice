import { access } from "node:fs/promises";
import * as NodePath from "node:path";

import type { CleanupStyle, S1Mini } from "@voice/cleanup";

import type { ModelStatus } from "../shared/api.ts";

// The package is reached through a dynamic import so node-llama-cpp, which it loads lazily,
// stays off the startup and hotkey paths and out of the CJS bundle's static graph.
export type CleanupModule = Pick<
  typeof import("@voice/cleanup"),
  "S1_MINI_FILE" | "createS1Mini" | "downloadS1Mini"
>;

export type Cleanup = {
  /** Loads the model when its file is present, otherwise reports missing. */
  load(): Promise<void>;
  /** Downloads and loads the model. A second call while in flight joins the first. */
  setup(): Promise<void>;
  clean(raw: string, style: CleanupStyle): Promise<string>;
  dispose(): Promise<void>;
};

export type CleanupOptions = {
  modelsDir: string;
  onStatus: (status: ModelStatus) => void;
  loadModule?: () => Promise<CleanupModule>;
};

const importModule = (): Promise<CleanupModule> => import("@voice/cleanup");

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createCleanup(options: CleanupOptions): Cleanup {
  const loadModule = options.loadModule ?? importModule;
  let engine: S1Mini | null = null;
  let inFlight: Promise<void> | null = null;

  async function loadModel(module: CleanupModule) {
    options.onStatus({ state: "loading" });
    try {
      const created = module.createS1Mini({
        modelPath: NodePath.join(options.modelsDir, module.S1_MINI_FILE),
      });
      await created.load();
      engine = created;
      options.onStatus({ state: "ready" });
    } catch (error) {
      options.onStatus({ state: "failed", message: message(error) });
    }
  }

  function once(work: () => Promise<void>) {
    if (inFlight) return inFlight;
    inFlight = work().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    load: () =>
      once(async () => {
        if (engine) return;
        const module = await loadModule();
        try {
          await access(NodePath.join(options.modelsDir, module.S1_MINI_FILE));
        } catch {
          options.onStatus({ state: "missing" });
          return;
        }
        await loadModel(module);
      }),
    setup: () =>
      once(async () => {
        if (engine) return;
        options.onStatus({ state: "downloading", progress: 0 });
        const module = await loadModule();
        try {
          await module.downloadS1Mini({
            dir: options.modelsDir,
            onProgress: (progress) => options.onStatus({ state: "downloading", progress }),
          });
        } catch (error) {
          options.onStatus({ state: "failed", message: message(error) });
          return;
        }
        await loadModel(module);
      }),
    clean(raw, style) {
      if (!engine) return Promise.reject(new Error("cleanup model is not ready"));
      return engine.clean(raw, style);
    },
    async dispose() {
      const current = engine;
      engine = null;
      await current?.dispose();
    },
  };
}

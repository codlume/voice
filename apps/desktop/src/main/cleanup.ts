import { access } from "node:fs/promises";
import * as NodePath from "node:path";

import type { ModelStatus, Settings } from "../shared/api.ts";

export type CleanupStyle = Omit<Settings["cleanup"], "enabled">;

// The @voice/cleanup contract. The package is imported lazily because loading it pulls in
// node-llama-cpp, which must stay off the startup and hotkey paths.
export type CleanupModule = {
  downloadS1Mini(opts: { dir: string; onProgress?: (fraction: number) => void }): Promise<string>;
  createS1Mini(opts: { modelPath: string }): {
    load(): Promise<void>;
    clean(raw: string, style: CleanupStyle): Promise<string>;
    dispose(): Promise<void>;
  };
};

// Mirrors S1_MINI_FILE in @voice/cleanup, kept local so the existence check at startup does
// not need to import the package.
export const S1_MINI_FILE = "s1-mini-q4_k_m.gguf";

type Engine = ReturnType<CleanupModule["createS1Mini"]>;

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

const importModule = (): Promise<CleanupModule> =>
  import("@voice/cleanup") as unknown as Promise<CleanupModule>;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createCleanup(options: CleanupOptions): Cleanup {
  const loadModule = options.loadModule ?? importModule;
  const modelPath = NodePath.join(options.modelsDir, S1_MINI_FILE);
  let engine: Engine | null = null;
  let inFlight: Promise<void> | null = null;

  async function loadModel() {
    options.onStatus({ state: "loading" });
    try {
      const created = (await loadModule()).createS1Mini({ modelPath });
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
        try {
          await access(modelPath);
        } catch {
          options.onStatus({ state: "missing" });
          return;
        }
        await loadModel();
      }),
    setup: () =>
      once(async () => {
        if (engine) return;
        options.onStatus({ state: "downloading", progress: 0 });
        try {
          await (
            await loadModule()
          ).downloadS1Mini({
            dir: options.modelsDir,
            onProgress: (progress) => options.onStatus({ state: "downloading", progress }),
          });
        } catch (error) {
          options.onStatus({ state: "failed", message: message(error) });
          return;
        }
        await loadModel();
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

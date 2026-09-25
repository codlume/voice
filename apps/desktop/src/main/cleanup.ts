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
  /** True once the model is in memory, including during warm-up, when clean() queues behind it. */
  loaded(): boolean;
  clean(raw: string, style: CleanupStyle): Promise<string>;
  dispose(): Promise<void>;
};

export type CleanupOptions = {
  modelsDir: string;
  onStatus: (status: ModelStatus) => void;
  loadModule?: () => Promise<CleanupModule>;
};

const importModule = (): Promise<CleanupModule> => import("@voice/cleanup");

// The first generation after load pays one-time costs (about 600 ms against 250 ms warm), so a
// throwaway clean runs before the model reports ready instead of inside the first session.
const WARM_UP_TEXT = "um so this is a quick warm up";
const WARM_UP_STYLE: CleanupStyle = {
  styling: "semi-formal",
  structure: "prose",
  context: "general",
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// A model has an owner from the moment its load starts, so dispose() can take over a load that
// is still in flight instead of letting it finish after the app has torn down.
type Model =
  | { phase: "none" }
  | { phase: "loading"; model: S1Mini }
  | { phase: "loaded"; model: S1Mini };

export function createCleanup(options: CleanupOptions): Cleanup {
  const loadModule = options.loadModule ?? importModule;
  let model: Model = { phase: "none" };
  let inFlight: Promise<void> | null = null;

  const owns = (candidate: S1Mini) => model.phase !== "none" && model.model === candidate;

  async function loadModel(module: CleanupModule) {
    options.onStatus({ state: "loading" });
    const created = module.createS1Mini({
      modelPath: NodePath.join(options.modelsDir, module.S1_MINI_FILE),
    });
    model = { phase: "loading", model: created };
    try {
      await created.load();
    } catch (error) {
      if (owns(created)) model = { phase: "none" };
      options.onStatus({ state: "failed", message: message(error) });
      return;
    }
    if (!owns(created)) return;
    model = { phase: "loaded", model: created };
    // Only the one-time cost matters here. A real clean that fails the same way falls back to raw.
    await created.clean(WARM_UP_TEXT, WARM_UP_STYLE).catch(() => undefined);
    if (owns(created)) options.onStatus({ state: "ready" });
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
        if (model.phase !== "none") return;
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
        if (model.phase !== "none") return;
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
    loaded: () => model.phase === "loaded",
    clean(raw, style) {
      if (model.phase !== "loaded") return Promise.reject(new Error("cleanup model is not ready"));
      return model.model.clean(raw, style);
    },
    // The adapter's dispose waits for a load that is still in flight, then frees it.
    async dispose() {
      if (model.phase === "none") return;
      const current = model.model;
      model = { phase: "none" };
      await current.dispose();
    },
  };
}

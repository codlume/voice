import { access } from "node:fs/promises";
import * as NodePath from "node:path";

import type { CleanupStyle, S1Mini } from "@voice/cleanup";

import type { ModelStatus } from "../shared/api.ts";

export type CleanupModule = Pick<
  typeof import("@voice/cleanup"),
  "S1_MINI_FILE" | "createS1Mini" | "downloadS1Mini"
>;

export type Cleanup = {
  loadIfDownloaded(): Promise<void>;
  downloadAndLoad(): Promise<void>;
  loaded(): boolean;
  clean(raw: string, style: CleanupStyle, signal: AbortSignal): Promise<string>;
  dispose(): Promise<void>;
};

export type CleanupOptions = {
  modelsDir: string;
  // New loads and downloads require cleanup to be enabled for the selected language.
  enabled: () => boolean;
  onStatus: (status: ModelStatus) => void;
  loadModule?: () => Promise<CleanupModule>;
};

const importModule = (): Promise<CleanupModule> => import("@voice/cleanup");

const WARM_UP_TEXT = "um so this is a quick warm up";
const WARM_UP_STYLE: CleanupStyle = { styling: "semi-formal" };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Model =
  | { phase: "none" }
  | { phase: "loading"; model: S1Mini }
  | { phase: "loaded"; model: S1Mini }
  // Left behind by dispose so a load or download still in flight does not bring the model back.
  | { phase: "disposed" };

const held = (model: Model): model is Extract<Model, { model: S1Mini }> =>
  model.phase === "loading" || model.phase === "loaded";

export function createCleanup(options: CleanupOptions): Cleanup {
  const loadModule = options.loadModule ?? importModule;
  let model: Model = { phase: "none" };
  let chain: Promise<void> = Promise.resolve();

  const owns = (candidate: S1Mini) => held(model) && model.model === candidate;

  // Loads, downloads, and the wait for a dispose run one at a time, so switching cleanup off
  // and back on during a load frees the first model before the second one is created.
  function serialize(work: () => Promise<void>) {
    const run = chain.then(work);
    chain = run.catch(() => undefined);
    return run;
  }

  // True when a load may start: cleanup is on and no model is held or being loaded.
  function begin(): boolean {
    if (!options.enabled()) return false;
    if (model.phase === "disposed") model = { phase: "none" };
    return model.phase === "none";
  }

  async function loadModel(module: CleanupModule) {
    if (model.phase !== "none") return;
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
    await created.clean(WARM_UP_TEXT, WARM_UP_STYLE).catch(() => undefined);
    if (owns(created)) options.onStatus({ state: "ready" });
  }

  return {
    loadIfDownloaded: () =>
      serialize(async () => {
        if (!begin()) return;
        const module = await loadModule();
        try {
          await access(NodePath.join(options.modelsDir, module.S1_MINI_FILE));
        } catch {
          options.onStatus({ state: "missing" });
          return;
        }
        await loadModel(module);
      }),
    downloadAndLoad: () =>
      serialize(async () => {
        if (!begin()) return;
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
    clean(raw, style, signal) {
      if (model.phase !== "loaded") return Promise.reject(new Error("cleanup model is not ready"));
      return model.model.clean(raw, style, signal);
    },
    dispose() {
      const current = model;
      model = { phase: "disposed" };
      // Disposing right away aborts a running warm-up instead of waiting behind it.
      const freed = held(current) ? current.model.dispose() : Promise.resolve();
      return serialize(() => freed);
    },
  };
}

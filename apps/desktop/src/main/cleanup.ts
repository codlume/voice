import { access } from "node:fs/promises";
import * as NodePath from "node:path";

import type { CleanupStyle, S1Mini } from "@voice/cleanup";

import type { ModelStatus } from "../shared/api.ts";

export type CleanupModule = Pick<
  typeof import("@voice/cleanup"),
  "S1_MINI_FILE" | "createS1Mini" | "downloadS1Mini"
>;

export type Cleanup = {
  load(): Promise<void>;
  setup(): Promise<void>;
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

const WARM_UP_TEXT = "um so this is a quick warm up";
const WARM_UP_STYLE: CleanupStyle = {
  styling: "semi-formal",
  structure: "prose",
  context: "general",
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
    async dispose() {
      if (model.phase === "none") return;
      const current = model.model;
      model = { phase: "none" };
      await current.dispose();
    },
  };
}

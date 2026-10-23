import type { Settings } from "./api.ts";
import { wantsCleanup } from "./dictation-language.ts";

export type BusyDuring = "dictation" | "transform";

export const models = [
  {
    id: "asr",
    kind: "Speech model",
    purpose: "Speech recognition",
    name: "Parakeet",
    vendor: "NVIDIA",
    size: "480 MB",
    lostUntilReinstalled: "Dictation stops working",
    busyDuring: "dictation",
    cancelableDownload: false,
    wanted: () => true,
  },
  {
    id: "cleanup",
    kind: "Cleanup model",
    purpose: "Text cleanup",
    name: "S1-mini",
    vendor: "Superwhisper",
    size: "480 MB",
    lostUntilReinstalled: "Text cleanup stops",
    // Dictation falls back to the raw transcript without it.
    busyDuring: null,
    cancelableDownload: true,
    wanted: (settings: Settings) => wantsCleanup(settings),
  },
  {
    id: "transform",
    kind: "Transform model",
    purpose: "Transforms",
    name: "Gemma 4 E2B",
    vendor: "Google",
    size: "3.1 GB",
    lostUntilReinstalled: "Transforms stop working",
    busyDuring: "transform",
    cancelableDownload: true,
    wanted: (settings: Settings) => settings.transforms.enabled,
  },
] as const;

export type Model = (typeof models)[number];
export type ModelId = Model["id"];

export const modelById: { [Id in ModelId]: Extract<Model, { id: Id }> } = {
  asr: models[0],
  cleanup: models[1],
  transform: models[2],
};

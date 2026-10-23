export const models = [
  {
    id: "asr",
    kind: "Speech model",
    purpose: "Speech recognition",
    name: "Parakeet",
    vendor: "NVIDIA",
    size: "480 MB",
    lostUntilReinstalled: "Dictation stops working",
    neededWhileDictating: true,
    cancelableDownload: false,
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
    neededWhileDictating: false,
    cancelableDownload: true,
  },
  {
    id: "transform",
    kind: "Transform model",
    purpose: "Transforms",
    name: "Gemma 4 E2B",
    vendor: "Google",
    size: "3.1 GB",
    lostUntilReinstalled: "Transforms stop working",
    neededWhileDictating: false,
    cancelableDownload: true,
  },
] as const;

export type Model = (typeof models)[number];
export type ModelId = Model["id"];

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
  },
] as const;

export type Model = (typeof models)[number];
export type ModelId = Model["id"];

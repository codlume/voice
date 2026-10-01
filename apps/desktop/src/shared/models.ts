export const models = [
  {
    id: "asr",
    kind: "Speech model",
    purpose: "Speech recognition",
    name: "Parakeet",
    vendor: "NVIDIA",
    size: "480 MB",
  },
  {
    id: "cleanup",
    kind: "Cleanup model",
    purpose: "Text cleanup",
    name: "S1-mini",
    vendor: "Superwhisper",
    size: "480 MB",
  },
] as const;

export type Model = (typeof models)[number];
export type ModelId = Model["id"];

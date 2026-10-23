// The one place that names the transform model. Swapping it edits this constant, the chat
// wrapper switch in engine.ts and the display row in the desktop app's models list.
import { GEMMA_4_E2B, type ModelSource } from "../download.ts";

export type ChatFlavour = "gemma4";

export type TransformModelSpec = {
  readonly source: ModelSource;
  readonly chat: ChatFlavour;
  // Tokens in the one context sequence the engine reuses for every run.
  readonly contextSize: number;
  // The most words a selection may have, whatever its tokens.
  readonly maxWords: number;
};

// 8,192 tokens cost 23 MB more Metal memory than 4,096 and fit 1,000 words of Polish with room
// for a rewrite twice as long (measured, #312).
export const TRANSFORM_MODEL: TransformModelSpec = {
  source: GEMMA_4_E2B,
  chat: "gemma4",
  contextSize: 8192,
  maxWords: 1000,
};

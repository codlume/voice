import { APACHE_2_0_LICENSE } from "../apache-2.0.ts";
import type { ModelSource } from "../download.ts";

// Gemma 4 is Apache 2.0, and the pinned unsloth/gemma-4-E2B-it-GGUF commit ships no LICENSE.
export const GEMMA_4_E2B: ModelSource = {
  baseUrl:
    "https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/0314792d7f1f7e229411f620751375812bb9faf2",
  file: "gemma-4-E2B-it-Q4_K_M.gguf",
  bytes: 3_106_738_272,
  sha256: "740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8",
  legal: [{ name: "LICENSE", from: "bundled", text: APACHE_2_0_LICENSE }],
};

export type TransformModelSpec = {
  readonly source: ModelSource;
  readonly contextSize: number;
  readonly maxWords: number;
  readonly gpuLayers: number;
};

// 8,192 tokens cost 23 MB more Metal memory than 4,096 and fit 1,000 words of Polish with room
// for a rewrite twice as long (measured, #312).
export const TRANSFORM_MODEL: TransformModelSpec = {
  source: GEMMA_4_E2B,
  contextSize: 8192,
  maxWords: 1000,
  // Gemma 4 E2B's 35 blocks plus its output layer.
  gpuLayers: 36,
};

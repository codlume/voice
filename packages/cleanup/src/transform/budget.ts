export const OUTPUT_MARGIN_TOKENS = 256;

export type Budget = { ok: true; maxTokens: number } | { ok: false; maxWords: number };

export function budget(
  { words, textTokens, promptTokens }: { words: number; textTokens: number; promptTokens: number },
  { contextSize, maxWords }: { contextSize: number; maxWords: number },
): Budget {
  const maxTokens = 2 * textTokens + OUTPUT_MARGIN_TOKENS;
  if (words <= maxWords && promptTokens + maxTokens <= contextSize) return { ok: true, maxTokens };
  const fixedTokens = promptTokens - textTokens;
  const tokensPerWord = textTokens / Math.max(1, words);
  const fittingWords = Math.floor(
    (contextSize - fixedTokens - OUTPUT_MARGIN_TOKENS) / (3 * tokensPerWord),
  );
  return { ok: false, maxWords: Math.max(0, Math.min(maxWords, fittingWords)) };
}

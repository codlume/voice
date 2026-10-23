// Whether a selection fits the model, and how many tokens its result may use.

// Room for a result somewhat longer than twice its text, such as a short text made into a list.
export const OUTPUT_MARGIN_TOKENS = 256;

export type Budget = { ok: true; maxTokens: number } | { ok: false; maxWords: number };

// promptTokens counts the whole prompt, the text's textTokens included. A fitting selection leaves
// room for a result twice its length, so maxTokens never runs past the context.
export function budget(
  { words, textTokens, promptTokens }: { words: number; textTokens: number; promptTokens: number },
  { contextSize, maxWords }: { contextSize: number; maxWords: number },
): Budget {
  const maxTokens = 2 * textTokens + OUTPUT_MARGIN_TOKENS;
  if (words <= maxWords && promptTokens + maxTokens <= contextSize) return { ok: true, maxTokens };
  // The limit the user sees uses this text's tokens per word, so Polish gets a lower one than English.
  const fixedTokens = promptTokens - textTokens;
  const tokensPerWord = textTokens / Math.max(1, words);
  const fittingWords = Math.floor(
    (contextSize - fixedTokens - OUTPUT_MARGIN_TOKENS) / (3 * tokensPerWord),
  );
  return { ok: false, maxWords: Math.max(0, Math.min(maxWords, fittingWords)) };
}

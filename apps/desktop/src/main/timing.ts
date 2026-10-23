// What the two effect runners share about time, so neither imports the other for it.

/** A time budget that grows with the text and stops at a cap. */
export type Budget = { base: number; perWord: number; max: number };

export const budget = ({ base, perWord, max }: Budget, words: number) =>
  Math.min(max, base + perWord * words);

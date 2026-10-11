// Spoken phrases that Voice finds inside dictated text: snippet triggers and dictionary entries.

// A phrase's identity: case, punctuation, symbols, and spacing never tell two phrases apart.
export const phraseKey = (text: string) => text.toLowerCase().replace(/[\p{P}\p{S}\p{Z}\s]/gu, "");

const NOT_BEFORE_CONTRACTION_T = "(?!['‘’´`′]t(?![\\p{L}\\p{N}]))";

// Marks count as word characters so a decomposed accent is never split from its letter.
const STARTS_WITH_WORD = /^[\p{L}\p{M}\p{N}_]/u;
const ENDS_WITH_WORD = /[\p{L}\p{M}\p{N}_]$/u;

// Regex source that finds the phrase as whole words, with any run of whitespace between them.
// "don" never matches inside "don't".
export function phrasePattern(phrase: string): string {
  const words = phrase.match(/\S+/gu) ?? [];
  const body = words.map((word) => RegExp.escape(word)).join("\\s+");
  const before = STARTS_WITH_WORD.test(words[0] ?? "") ? "(?<![\\p{L}\\p{M}\\p{N}_])" : "";
  const after = ENDS_WITH_WORD.test(words.at(-1) ?? "")
    ? `(?![\\p{L}\\p{M}\\p{N}_])${NOT_BEFORE_CONTRACTION_T}`
    : "";
  return `${before}${body}${after}`;
}

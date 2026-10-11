import { matchKey } from "./phrase.ts";
import type { Snippet } from "./snippets.ts";

// replacement null is a word: Voice rewrites the phrase with its saved spelling.
export type DictionaryEntry = { id: string; phrase: string; replacement: string | null };

export const PHRASE_MAX_LENGTH = 100;
export const REPLACEMENT_MAX_LENGTH = 500;

export type DictionaryProblem = { field: "phrase" | "replacement"; message: string };

// `others` never contains the entry being checked; callers filter it out.
export function dictionaryProblem(
  entry: DictionaryEntry,
  others: readonly DictionaryEntry[],
  snippets: readonly Snippet[],
): DictionaryProblem | null {
  const { phrase, replacement } = entry;
  if (phrase === "") return { field: "phrase", message: "Enter a word or phrase." };
  if (!/[\p{L}\p{N}]/u.test(phrase)) {
    return { field: "phrase", message: "Use at least one letter or number." };
  }
  if (phrase.length > PHRASE_MAX_LENGTH) {
    return { field: "phrase", message: `Use ${PHRASE_MAX_LENGTH} characters or fewer.` };
  }
  // Two phrases the rewrite pass could not tell apart are one entry.
  const key = matchKey(phrase);
  if (others.some((other) => matchKey(other.phrase) === key)) {
    return { field: "phrase", message: "This phrase is already in your dictionary." };
  }
  if (isSnippetTrigger(phrase, snippets)) {
    return { field: "phrase", message: "This phrase is already a snippet trigger." };
  }
  if (replacement === null) return null;
  if (replacement.trim() === "") {
    return { field: "replacement", message: "Enter the text Voice should type." };
  }
  if (replacement.length > REPLACEMENT_MAX_LENGTH) {
    return { field: "replacement", message: `Use ${REPLACEMENT_MAX_LENGTH} characters or fewer.` };
  }
  return null;
}

// A dictionary phrase that is also a snippet trigger would shadow it, or be shadowed by it.
export function isSnippetTrigger(phrase: string, snippets: readonly Snippet[]): boolean {
  const key = matchKey(phrase);
  return snippets.some((snippet) => matchKey(snippet.trigger) === key);
}

// Snippets default to none, so loading a settings file never drops an entry that a snippet saved
// later collides with; saves check that through `snippets`.
export function parseDictionary(
  raw: unknown,
  snippets: readonly Snippet[] = [],
): DictionaryEntry[] {
  if (!Array.isArray(raw)) return [];
  const kept: DictionaryEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { id, phrase, replacement } = item as Record<string, unknown>;
    if (typeof id !== "string" || typeof phrase !== "string") continue;
    if (replacement !== null && typeof replacement !== "string") continue;
    const entry = { id, phrase: phrase.trim(), replacement: replacement?.trim() ?? null };
    if (kept.some((other) => other.id === id) || dictionaryProblem(entry, kept, snippets)) {
      continue;
    }
    kept.push(entry);
  }
  return kept;
}

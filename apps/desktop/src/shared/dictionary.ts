import { samePhrase } from "./phrase.ts";
import type { Snippet } from "./snippets.ts";

// replacement null is a word: Voice rewrites the phrase with its saved spelling.
export type DictionaryEntry = { id: string; phrase: string; replacement: string | null };

export const PHRASE_MAX_LENGTH = 100;
export const REPLACEMENT_MAX_LENGTH = 500;

export type DictionaryProblem = { field: "phrase" | "replacement"; message: string };

// What the dialog and the settings file both mean: a trimmed phrase, and a word when "Replace
// with" is left blank.
export function dictionaryEntry({ id, phrase, replacement }: DictionaryEntry): DictionaryEntry {
  const text = replacement?.trim() ?? "";
  return { id, phrase: phrase.trim(), replacement: text === "" ? null : text };
}

// `entry` comes from `dictionaryEntry`, so its replacement is never blank. `others` never contains
// the entry being checked; callers filter it out.
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
  if (others.some((other) => samePhrase(other.phrase, phrase))) {
    return { field: "phrase", message: "This phrase is already in your dictionary." };
  }
  if (snippets.some((snippet) => samePhrase(snippet.trigger, phrase))) {
    return { field: "phrase", message: "This phrase is already a snippet trigger." };
  }
  if (replacement !== null && replacement.length > REPLACEMENT_MAX_LENGTH) {
    return { field: "replacement", message: `Use ${REPLACEMENT_MAX_LENGTH} characters or fewer.` };
  }
  return null;
}

// Loading keeps a phrase that another entry or a snippet already has; only the pages refuse new
// ones, and the rewrite pass lets the later one win.
export function parseDictionary(raw: unknown): DictionaryEntry[] {
  if (!Array.isArray(raw)) return [];
  const kept: DictionaryEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { id, phrase, replacement } = item as Record<string, unknown>;
    if (typeof id !== "string" || typeof phrase !== "string") continue;
    if (replacement !== null && typeof replacement !== "string") continue;
    const entry = dictionaryEntry({ id, phrase, replacement });
    if (kept.some((other) => other.id === id) || dictionaryProblem(entry, [], [])) continue;
    kept.push(entry);
  }
  return kept;
}

import { phraseKey, phrasePattern } from "./phrase.ts";
import type { Snippet } from "./snippets.ts";

// replacement null is a word: Voice rewrites the phrase with its saved spelling.
export type DictionaryEntry = { id: string; phrase: string; replacement: string | null };

export const PHRASE_MAX_LENGTH = 100;
export const REPLACEMENT_MAX_LENGTH = 500;

export type DictionaryProblem = { field: "phrase" | "replacement"; message: string };

// Letters that do not decompose, such as Ł, keep their shape.
const withoutAccents = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "");

const entryKey = (text: string) => phraseKey(withoutAccents(text));

// The text without accents, and for each of its UTF-16 offsets, plus its end, the matching offset
// in the original. A dropped combining mark sits before the next offset, so a match keeps it.
function foldAccents(text: string) {
  let folded = "";
  const source: number[] = [];
  let at = 0;
  for (const char of text) {
    const base = withoutAccents(char);
    for (let unit = 0; unit < base.length; unit += 1) source.push(at);
    folded += base;
    at += char.length;
  }
  source.push(at);
  return { folded, source };
}

// One pass over the text, longest phrase first. Output is never re-scanned, and text outside a
// match is kept as is.
export function applyDictionary(text: string, entries: readonly DictionaryEntry[]): string {
  if (entries.length === 0) return text;
  const byKey = new Map(entries.map((entry) => [entryKey(entry.phrase), entry]));
  const alternation = entries
    .map((entry) => withoutAccents(entry.phrase))
    .toSorted((a, b) => b.length - a.length)
    .map(phrasePattern)
    .join("|");
  const { folded, source } = foldAccents(text);
  let result = "";
  let copied = 0;
  for (const match of folded.matchAll(new RegExp(alternation, "giu"))) {
    // The regex folds case more widely than toLowerCase (ſ matches s); leave such a match alone.
    const entry = byKey.get(entryKey(match[0]));
    if (!entry) continue;
    const start = source[match.index];
    const end = source[match.index + match[0].length]!;
    result += text.slice(copied, start) + written(entry, text.slice(start, end));
    copied = end;
  }
  return result + text.slice(copied);
}

// A word saved all lowercase keeps the capital the speech model gave a sentence start.
function written({ phrase, replacement }: DictionaryEntry, matched: string): string {
  if (replacement !== null) return replacement;
  if (/\p{Lu}/u.test(phrase) || !/^\p{Lu}/u.test(matched)) return phrase;
  return phrase.replace(/^./u, (first) => first.toUpperCase());
}

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
  const key = entryKey(phrase);
  if (others.some((other) => entryKey(other.phrase) === key)) {
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

// A dictionary phrase that is also a snippet trigger would be rewritten before it could expand.
export function isSnippetTrigger(phrase: string, snippets: readonly Snippet[]): boolean {
  const key = entryKey(phrase);
  return snippets.some((snippet) => entryKey(snippet.trigger) === key);
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

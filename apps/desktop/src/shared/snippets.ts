export type Snippet = { id: string; trigger: string; expansion: string; enabled: boolean };

export const TRIGGER_MAX_LENGTH = 60;
export const EXPANSION_MAX_LENGTH = 4000;

// count 0 means no trigger matched and text is the input unchanged.
export type Expansion = { text: string; count: number; entireDictation: boolean };

export type SnippetProblem = { field: "trigger" | "expansion"; message: string };

// A trigger's identity: case, punctuation, symbols, and spacing never tell two triggers apart.
const triggerKey = (text: string) => text.toLowerCase().replace(/[\p{P}\p{S}\p{Z}\s]/gu, "");

const NOT_BEFORE_CONTRACTION_T = "(?!['‘’´`′]t(?![\\p{L}\\p{N}]))";

// Marks count as word characters so a decomposed accent is never split from its letter.
const STARTS_WITH_WORD = /^[\p{L}\p{M}\p{N}_]/u;
const ENDS_WITH_WORD = /[\p{L}\p{M}\p{N}_]$/u;

function triggerPattern(trigger: string): string {
  const words = trigger.match(/\S+/gu) ?? [];
  const body = words.map((word) => RegExp.escape(word)).join("\\s+");
  const before = STARTS_WITH_WORD.test(words[0] ?? "") ? "(?<![\\p{L}\\p{M}\\p{N}_])" : "";
  const after = ENDS_WITH_WORD.test(words.at(-1) ?? "")
    ? `(?![\\p{L}\\p{M}\\p{N}_])${NOT_BEFORE_CONTRACTION_T}`
    : "";
  return `${before}${body}${after}`;
}

export function expandSnippets(text: string, snippets: readonly Snippet[]): Expansion {
  const byKey = new Map(snippets.filter((s) => s.enabled).map((s) => [triggerKey(s.trigger), s]));
  const entire = byKey.get(triggerKey(text));
  if (entire) return { text: entire.expansion, count: 1, entireDictation: true };
  if (byKey.size === 0) return { text, count: 0, entireDictation: false };

  const alternation = [...byKey.values()]
    .map((s) => s.trigger)
    .toSorted((a, b) => b.length - a.length)
    .map(triggerPattern)
    .join("|");
  let count = 0;
  const expanded = text.replace(new RegExp(alternation, "giu"), (match) => {
    // The regex folds case more widely than toLowerCase (ſ matches s); leave such a match alone.
    const snippet = byKey.get(triggerKey(match));
    if (!snippet) return match;
    count += 1;
    return snippet.expansion;
  });
  return { text: expanded, count, entireDictation: false };
}

// What to insert after cleanup: the cleaned text with snippets expanded, unless cleanup lost a
// trigger the raw transcript had (the local model cannot be told to keep them), then the expanded
// raw transcript. "" only when cleanup emptied a transcript that had no trigger.
export function snippetText(raw: string, cleaned: string, snippets: readonly Snippet[]): string {
  const fromRaw = expandSnippets(raw, snippets);
  const fromCleaned = expandSnippets(cleaned, snippets);
  return fromCleaned.count < fromRaw.count ? fromRaw.text : fromCleaned.text;
}

// `others` never contains the snippet being checked; callers filter it out.
export function snippetProblem(
  snippet: Snippet,
  others: readonly Snippet[],
): SnippetProblem | null {
  const { trigger, expansion } = snippet;
  if (trigger === "") return { field: "trigger", message: "Enter a trigger phrase." };
  if (!/[\p{L}\p{N}]/u.test(trigger)) {
    return { field: "trigger", message: "Use at least one letter or number." };
  }
  if (trigger.length > TRIGGER_MAX_LENGTH) {
    return { field: "trigger", message: `Use ${TRIGGER_MAX_LENGTH} characters or fewer.` };
  }
  const key = triggerKey(trigger);
  if (others.some((other) => triggerKey(other.trigger) === key)) {
    return { field: "trigger", message: "This trigger is already used by another snippet." };
  }
  if (expansion.trim() === "") {
    return { field: "expansion", message: "Enter the text Voice should type." };
  }
  if (expansion.length > EXPANSION_MAX_LENGTH) {
    return {
      field: "expansion",
      message: `Use ${EXPANSION_MAX_LENGTH.toLocaleString("en-US")} characters or fewer.`,
    };
  }
  return null;
}

export function parseSnippets(raw: unknown): Snippet[] {
  if (!Array.isArray(raw)) return [];
  const kept: Snippet[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { id, trigger, expansion, enabled } = item as Record<string, unknown>;
    if (typeof id !== "string" || typeof trigger !== "string" || typeof expansion !== "string") {
      continue;
    }
    // Snippets saved before the on/off switch existed have no `enabled` and stay on.
    const snippet = { id, trigger: trigger.trim(), expansion, enabled: enabled !== false };
    if (kept.some((other) => other.id === id) || snippetProblem(snippet, kept)) continue;
    kept.push(snippet);
  }
  return kept;
}

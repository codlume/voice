export type Snippet = { id: string; trigger: string; expansion: string };

export const TRIGGER_MAX_LENGTH = 60;
export const EXPANSION_MAX_LENGTH = 4000;

export type Expansion =
  | { kind: "none" }
  | { kind: "entireDictation"; text: string }
  | { kind: "inline"; text: string; count: number };

export type SnippetProblem = { field: "trigger" | "expansion"; message: string };

const triggerKey = (text: string) => text.toLowerCase().replace(/[\p{P}\p{S}\p{Z}\s]/gu, "");

const canonical = (text: string) => text.toLowerCase().replace(/\s+/gu, " ");

const NOT_BEFORE_CONTRACTION_T = "(?!['‘’´`′]t(?![\\p{L}\\p{N}]))";

const STARTS_WITH_WORD = /^[\p{L}\p{N}_]/u;
const ENDS_WITH_WORD = /[\p{L}\p{N}_]$/u;

function triggerPattern(trigger: string): string {
  const body = trigger
    .split(/\s+/u)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
    .join("\\s+");
  const before = STARTS_WITH_WORD.test(trigger) ? "(?<![\\p{L}\\p{N}_])" : "";
  const after = ENDS_WITH_WORD.test(trigger)
    ? `(?![\\p{L}\\p{N}_])${NOT_BEFORE_CONTRACTION_T}`
    : "";
  return `${before}${body}${after}`;
}

export function expandSnippets(text: string, snippets: readonly Snippet[]): Expansion {
  const spoken = triggerKey(text);
  const entire = spoken === "" ? undefined : snippets.find((s) => triggerKey(s.trigger) === spoken);
  if (entire) return { kind: "entireDictation", text: entire.expansion };
  if (snippets.length === 0) return { kind: "none" };

  const byKey = new Map<string, Snippet>();
  for (const snippet of snippets) {
    const key = canonical(snippet.trigger);
    if (!byKey.has(key)) byKey.set(key, snippet);
  }
  const alternation = [...byKey.values()]
    .map((snippet) => snippet.trigger)
    .toSorted((a, b) => b.length - a.length)
    .map(triggerPattern)
    .join("|");
  let count = 0;
  const expanded = text.replace(new RegExp(alternation, "giu"), (match) => {
    const snippet = byKey.get(canonical(match));
    if (!snippet) return match;
    count += 1;
    return snippet.expansion;
  });
  return count === 0 ? { kind: "none" } : { kind: "inline", text: expanded, count };
}

export function snippetProblem(snippet: Snippet, saved: readonly Snippet[]): SnippetProblem | null {
  const trigger = snippet.trigger.trim();
  const key = triggerKey(trigger);
  if (trigger === "") return { field: "trigger", message: "Enter a trigger phrase." };
  if (key === "") return { field: "trigger", message: "Use at least one letter or number." };
  if (trigger.length > TRIGGER_MAX_LENGTH) {
    return { field: "trigger", message: `Use ${TRIGGER_MAX_LENGTH} characters or fewer.` };
  }
  if (saved.some((other) => other.id !== snippet.id && triggerKey(other.trigger) === key)) {
    return { field: "trigger", message: "This trigger is already used by another snippet." };
  }
  if (snippet.expansion.trim() === "") {
    return { field: "expansion", message: "Enter the text Voice should type." };
  }
  if (snippet.expansion.length > EXPANSION_MAX_LENGTH) {
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
    const { id, trigger, expansion } = item as Record<string, unknown>;
    if (typeof id !== "string" || typeof trigger !== "string" || typeof expansion !== "string") {
      continue;
    }
    const snippet = { id, trigger: trigger.trim(), expansion };
    if (kept.some((other) => other.id === id) || snippetProblem(snippet, kept)) continue;
    kept.push(snippet);
  }
  return kept;
}

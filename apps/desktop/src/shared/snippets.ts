import { samePhrase } from "./phrase.ts";

export type Snippet = { id: string; trigger: string; expansion: string; enabled: boolean };

export const TRIGGER_MAX_LENGTH = 60;
export const EXPANSION_MAX_LENGTH = 4000;

export type SnippetProblem = { field: "trigger" | "expansion"; message: string };

// `others` never contains the snippet being checked; callers filter it out.
export function snippetProblem(
  snippet: Snippet,
  others: readonly Snippet[],
  dictionary: readonly { phrase: string }[],
): SnippetProblem | null {
  const { trigger, expansion } = snippet;
  if (trigger === "") return { field: "trigger", message: "Enter a trigger phrase." };
  if (!/[\p{L}\p{N}]/u.test(trigger)) {
    return { field: "trigger", message: "Use at least one letter or number." };
  }
  if (trigger.length > TRIGGER_MAX_LENGTH) {
    return { field: "trigger", message: `Use ${TRIGGER_MAX_LENGTH} characters or fewer.` };
  }
  if (others.some((other) => samePhrase(other.trigger, trigger))) {
    return { field: "trigger", message: "This trigger is already used by another snippet." };
  }
  if (dictionary.some((entry) => samePhrase(entry.phrase, trigger))) {
    return { field: "trigger", message: "This trigger is already in your dictionary." };
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
    // Loading keeps a trigger that another snippet or a dictionary entry already has; only the
    // pages refuse new ones, and the rewrite pass lets the later one win.
    if (kept.some((other) => other.id === id) || snippetProblem(snippet, [], [])) continue;
    kept.push(snippet);
  }
  return kept;
}

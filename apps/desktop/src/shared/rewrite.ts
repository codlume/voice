import type { DictionaryEntry } from "./dictionary.ts";
import { matchKey, phraseKey, withoutAccents } from "./phrase.ts";
import type { Snippet } from "./snippets.ts";

/** Everything the user saved that rewrites dictated text. */
export type Rewrites = { dictionary: readonly DictionaryEntry[]; snippets: readonly Snippet[] };

// `snippets` counts the snippet matches; 0 with `text` unchanged means nothing matched.
export type Rewritten = { text: string; snippets: number; entireDictation: boolean };

type Rule = { kind: "entry"; entry: DictionaryEntry } | { kind: "snippet"; snippet: Snippet };

type Matcher = {
  // Enabled snippets by trigger key, for a dictation that is only a trigger.
  entire: ReadonlyMap<string, Snippet>;
  rules: ReadonlyMap<string, Rule>;
  regex: RegExp | null;
};

const WORD = "[\\p{L}\\p{M}\\p{N}_]";
// A match sits between non-word characters or text edges, whatever the phrase starts or ends with,
// so "U.S." never matches inside "U.S.A.". "don" never matches the start of "don't".
const BEFORE = `(?<!${WORD})`;
const AFTER = `(?!${WORD})(?!['‘’´\`′]t(?!${WORD}))`;

const pattern = (key: string) =>
  key
    .split(" ")
    .map((word) => RegExp.escape(word))
    .join("\\s+");

function compile({ dictionary, snippets }: Rewrites): Matcher {
  const rules = new Map<string, Rule>();
  for (const entry of dictionary) rules.set(matchKey(entry.phrase), { kind: "entry", entry });
  const entire = new Map<string, Snippet>();
  for (const snippet of snippets) {
    if (!snippet.enabled) continue;
    // The pages refuse a trigger that is also a dictionary phrase; in an edited file the snippet wins.
    rules.set(matchKey(snippet.trigger), { kind: "snippet", snippet });
    entire.set(phraseKey(snippet.trigger), snippet);
  }
  if (rules.size === 0) return { entire, rules, regex: null };
  // Longest first, so the regex takes the longest phrase at any position. One boundary check
  // around the whole alternation compiles in milliseconds; one per phrase took seconds at 1,000.
  const alternation = [...rules.keys()]
    .toSorted((a, b) => b.length - a.length)
    .map(pattern)
    .join("|");
  return { entire, rules, regex: new RegExp(`${BEFORE}(?:${alternation})${AFTER}`, "giu") };
}

// Settings hand every session the same two arrays until the user edits a list, so one compiled
// matcher serves all the dictations in between.
let cached: { rewrites: Rewrites; matcher: Matcher } | null = null;

function matcher(rewrites: Rewrites): Matcher {
  if (
    cached?.rewrites.dictionary === rewrites.dictionary &&
    cached.rewrites.snippets === rewrites.snippets
  ) {
    return cached.matcher;
  }
  cached = { rewrites, matcher: compile(rewrites) };
  return cached.matcher;
}

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

/**
 * One pass over the text with every dictionary entry and enabled snippet, longest phrase first.
 * Matching ignores case and accents. Output is never scanned again, so a replacement's text never
 * sets off a snippet, and text outside a match is kept as is.
 */
export function rewrite(text: string, rewrites: Rewrites): Rewritten {
  const { entire, rules, regex } = matcher(rewrites);
  const whole = entire.get(phraseKey(text));
  if (whole) return { text: whole.expansion, snippets: 1, entireDictation: true };
  if (regex === null) return { text, snippets: 0, entireDictation: false };
  const { folded, source } = foldAccents(text);
  let result = "";
  let copied = 0;
  let count = 0;
  for (const match of folded.matchAll(regex)) {
    // The regex folds case more widely than toLowerCase (ſ matches s); leave such a match alone.
    const rule = rules.get(matchKey(match[0]));
    if (!rule) continue;
    // `source` has an entry for every folded offset and for the end, so both lookups hit.
    const start = source[match.index]!;
    const end = source[match.index + match[0].length]!;
    result += text.slice(copied, start) + write(rule, text.slice(start, end));
    copied = end;
    if (rule.kind === "snippet") count += 1;
  }
  return { text: result + text.slice(copied), snippets: count, entireDictation: false };
}

function write(rule: Rule, matched: string): string {
  if (rule.kind === "snippet") return rule.snippet.expansion;
  const { phrase, replacement } = rule.entry;
  if (replacement !== null) return replacement;
  // A word saved all lowercase keeps the capital the speech model gave a sentence start.
  if (/\p{Lu}/u.test(phrase) || !/^\p{Lu}/u.test(matched)) return phrase;
  return phrase.replace(/^./u, (first) => first.toUpperCase());
}

// What to insert after cleanup: the cleaned text rewritten, unless cleanup lost a snippet trigger
// the raw transcript had (the local model cannot be told to keep them), then the rewritten raw
// transcript. "" only when cleanup emptied a transcript that had no trigger.
export function finalText(raw: string, cleaned: string, rewrites: Rewrites): string {
  const fromRaw = rewrite(raw, rewrites);
  const fromCleaned = rewrite(cleaned, rewrites);
  return fromCleaned.snippets < fromRaw.snippets ? fromRaw.text : fromCleaned.text;
}

import type { DictionaryEntry } from "./dictionary.ts";
import { matchKey, withoutAccents } from "./phrase.ts";
import type { Snippet } from "./snippets.ts";

/** Everything the user saved that rewrites dictated text. */
export type Rewrites = { dictionary: readonly DictionaryEntry[]; snippets: readonly Snippet[] };

// `snippets` counts the snippet matches; 0 with `text` unchanged means nothing matched.
export type Rewritten = {
  text: string;
  snippets: number;
  dictionaryFixes: number;
  entireDictation: boolean;
};

type Rule = { kind: "entry"; entry: DictionaryEntry } | { kind: "snippet"; snippet: Snippet };

type Matcher = { rules: ReadonlyMap<string, Rule>; regex: RegExp | null };

// A rule's match in the original text.
type Found = { rule: Rule; start: number; end: number };

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
  // The pages refuse two phrases with one key; a loaded file may still hold such a pair, and the
  // later one wins, a snippet over an entry.
  for (const entry of dictionary) rules.set(matchKey(entry.phrase), { kind: "entry", entry });
  for (const snippet of snippets) {
    if (snippet.enabled) rules.set(matchKey(snippet.trigger), { kind: "snippet", snippet });
  }
  if (rules.size === 0) return { rules, regex: null };
  // Longest first, so the regex takes the longest phrase at any position. One boundary check
  // around the whole alternation compiles in milliseconds; one per phrase took seconds at 1,000.
  const alternation = [...rules.keys()]
    .toSorted((a, b) => b.length - a.length)
    .map(pattern)
    .join("|");
  const regex = new RegExp(`${BEFORE}(?:${alternation})${AFTER}`, "giu");
  // V8 compiles a regex on its first use and refuses a pattern past a few hundred kilobytes,
  // around 7,000 ten-word phrases. A hand-edited list that large then rewrites nothing, rather
  // than failing every dictation.
  try {
    regex.test("");
  } catch {
    return { rules, regex: null };
  }
  return { rules, regex };
}

// Settings hand every session the same two arrays until any setting changes, so one compiled
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
  const { rules, regex } = matcher(rewrites);
  if (regex === null) return { text, snippets: 0, dictionaryFixes: 0, entireDictation: false };
  const { folded, source } = foldAccents(text);
  const found: Found[] = [];
  regex.lastIndex = 0;
  for (let match = regex.exec(folded); match !== null; match = regex.exec(folded)) {
    const rule = rules.get(matchKey(match[0]));
    if (!rule) {
      // The regex folds case more widely than toLowerCase (ſ matches s). Leave such a match alone
      // and look again from its next character, so a shorter phrase inside it is not lost.
      regex.lastIndex = match.index + (folded.codePointAt(match.index)! > 0xffff ? 2 : 1);
      continue;
    }
    // `source` has an entry for every folded offset and for the end, so both lookups hit.
    const start = source[match.index]!;
    const end = source[match.index + match[0].length]!;
    found.push({ rule, start, end });
  }
  const whole = alone(text, found);
  if (whole) {
    return { text: whole.expansion, snippets: 1, dictionaryFixes: 0, entireDictation: true };
  }
  let result = "";
  let copied = 0;
  let snippets = 0;
  let dictionaryFixes = 0;
  for (const { rule, start, end } of found) {
    const matched = text.slice(start, end);
    const written = write(rule, matched);
    result += text.slice(copied, start) + written;
    copied = end;
    if (rule.kind === "snippet") snippets += 1;
    else if (written !== matched) dictionaryFixes += 1;
  }
  return { text: result + text.slice(copied), snippets, dictionaryFixes, entireDictation: false };
}

// The snippet when the dictation is only its trigger, give or take the punctuation the speech
// model puts around a phrase said on its own.
function alone(text: string, found: readonly Found[]): Snippet | null {
  const [only] = found;
  if (only === undefined || found.length > 1 || only.rule.kind !== "snippet") return null;
  const around = text.slice(0, only.start) + text.slice(only.end);
  return /^[\p{P}\p{S}\s]*$/u.test(around) ? only.rule.snippet : null;
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
// transcript.
export function finalRewrite(
  raw: string,
  cleaned: string,
  rewrites: Rewrites,
): Rewritten & { source: "raw" | "cleaned" } {
  const fromRaw = rewrite(raw, rewrites);
  const fromCleaned = rewrite(cleaned, rewrites);
  return fromCleaned.snippets < fromRaw.snippets
    ? { ...fromRaw, source: "raw" }
    : { ...fromCleaned, source: "cleaned" };
}

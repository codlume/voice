import type { DictionaryEntry } from "./dictionary.ts";
import { matchKey, withoutAccents } from "./phrase.ts";
import { escapeHtml, paragraphsAsLines } from "./snippet-html.ts";
import type { Snippet } from "./snippets.ts";

/** Everything the user saved that rewrites dictated text. */
export type Rewrites = { dictionary: readonly DictionaryEntry[]; snippets: readonly Snippet[] };

export type Output = { text: string; html: string | null };

// `snippets` counts the snippet matches; 0 with `text` unchanged means nothing matched.
export type Rewritten = Output & { snippets: number; entireDictation: boolean };

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
  if (regex === null) return { text, html: null, snippets: 0, entireDictation: false };
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
  if (whole) return { ...join([expanded(whole)]), snippets: 1, entireDictation: true };
  const pieces: Output[] = [];
  let copied = 0;
  let count = 0;
  for (const { rule, start, end } of found) {
    pieces.push(plain(text.slice(copied, start)), write(rule, text.slice(start, end)));
    copied = end;
    if (rule.kind === "snippet") count += 1;
  }
  pieces.push(plain(text.slice(copied)));
  return { ...join(pieces), snippets: count, entireDictation: false };
}

const plain = (text: string): Output => ({ text, html: null });
const expanded = (snippet: Snippet): Output => ({
  text: snippet.expansion,
  html: snippet.expansionHtml,
});

function join(pieces: readonly Output[]): Output {
  const text = pieces.map((piece) => piece.text).join("");
  if (pieces.every((piece) => piece.html === null)) return { text, html: null };
  const html = pieces.map((piece) =>
    piece.html === null
      ? escapeHtml(piece.text).replaceAll("\n", "<br>")
      : paragraphsAsLines(piece.html),
  );
  return { text, html: keepSpaces(html) };
}

const LINE_START = /^<(?:br|li)>$/i;
const LIST_END = /^<\/(?:ul|ol)>$/i;

// A rich target collapses a run of spaces to one and drops a space that starts a line. Alternating
// a no-break space with a space keeps the typed width and still lets the line wrap.
function keepSpaces(pieces: readonly string[]): string {
  let kept = "";
  let line: "start" | "after list" | "inside" = "start";
  for (const piece of pieces) {
    // Dictated words after a snippet's list continue the sentence; a target rightly drops their
    // separating space. A line of the snippet itself after its list keeps its leading space.
    if (line === "after list") line = "inside";
    // Text never holds a raw "<", so every part that starts with one is a tag.
    for (const part of piece.split(/(<[^>]*>)/)) {
      if (part.startsWith("<")) {
        if (LINE_START.test(part)) line = "start";
        else if (LIST_END.test(part)) line = "after list";
        kept += part;
        continue;
      }
      kept += part.replace(/ +/g, (run, offset: number) =>
        run.length > 1 || (offset === 0 && line !== "inside")
          ? Array.from(run, (_, at) => (at % 2 === 0 ? "&nbsp;" : " ")).join("")
          : run,
      );
      if (part !== "") line = "inside";
    }
  }
  return kept;
}

// The snippet when the dictation is only its trigger, give or take the punctuation the speech
// model puts around a phrase said on its own.
function alone(text: string, found: readonly Found[]): Snippet | null {
  const [only] = found;
  if (only === undefined || found.length > 1 || only.rule.kind !== "snippet") return null;
  const around = text.slice(0, only.start) + text.slice(only.end);
  return /^[\p{P}\p{S}\s]*$/u.test(around) ? only.rule.snippet : null;
}

function write(rule: Rule, matched: string): Output {
  if (rule.kind === "snippet") return expanded(rule.snippet);
  return plain(correct(rule.entry, matched));
}

function correct({ phrase, replacement }: DictionaryEntry, matched: string): string {
  if (replacement !== null) return replacement;
  // A word saved all lowercase keeps the capital the speech model gave a sentence start.
  if (/\p{Lu}/u.test(phrase) || !/^\p{Lu}/u.test(matched)) return phrase;
  return phrase.replace(/^./u, (first) => first.toUpperCase());
}

// What to insert after cleanup: the cleaned text rewritten, unless cleanup lost a snippet trigger
// the raw transcript had (the local model cannot be told to keep them), then the rewritten raw
// transcript. "" only when cleanup emptied a transcript that had no trigger.
export function finalOutput(raw: string, cleaned: string, rewrites: Rewrites): Output {
  const fromRaw = rewrite(raw, rewrites);
  const fromCleaned = rewrite(cleaned, rewrites);
  const { text, html } = fromCleaned.snippets < fromRaw.snippets ? fromRaw : fromCleaned;
  return { text, html };
}

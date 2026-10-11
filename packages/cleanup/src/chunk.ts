type CountTokens = (text: string) => number;

export type Chunk = { start: number; end: number; text: string };

const CLOSERS = `["'”’)\\]]*`;
const TERMINAL_END = new RegExp(`[.!?…]${CLOSERS}\\s*$`, "u");
const ABBREVIATION_END = new RegExp(
  `(?:\\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc)\\.|(?:\\p{L}\\.){2,})${CLOSERS}\\s*$`,
  "iu",
);
// UAX #29 does not end a sentence before a lowercase letter, so a lowercase dictation with
// periods still reads as one sentence to Intl.Segmenter.
const SENTENCE_END = new RegExp(`(?<=[.!?…]${CLOSERS}\\s+)(?!\\s)`, "u");
const CLAUSE_SEAM =
  /(?<=[,;:]\s+)(?!\s)|(?<=\s)(?=(?:and|but|so|or|then|because|which|while)(?!\p{L}))/iu;

const segmenter = (granularity: "sentence" | "word" | "grapheme") => {
  const intl = new Intl.Segmenter(undefined, { granularity });
  return (text: string) => Array.from(intl.segment(text), (s) => s.segment);
};
const sentences = segmenter("sentence");

const LEVELS: ((text: string) => string[])[] = [
  (text) => sentences(text).flatMap((sentence) => joinAbbreviations(sentence.split(SENTENCE_END))),
  (text) => joinAbbreviations(text.split(CLAUSE_SEAM)),
  segmenter("word"),
  segmenter("grapheme"),
];

function joinAbbreviations(parts: string[]): string[] {
  const joined: string[] = [];
  for (const part of parts) {
    const previous = joined.at(-1);
    if (previous !== undefined && ABBREVIATION_END.test(previous))
      joined[joined.length - 1] += part;
    else joined.push(part);
  }
  return joined;
}

function pieces(text: string, maxTokens: number, countTokens: CountTokens, level = 0): string[] {
  return LEVELS[level]!(text).flatMap((piece) =>
    countTokens(piece.trim()) > maxTokens && level < LEVELS.length - 1
      ? pieces(piece, maxTokens, countTokens, level + 1)
      : [piece],
  );
}

export function chunkTranscript(
  text: string,
  maxTokens: number,
  countTokens: CountTokens,
): Chunk[] {
  const chunks: Chunk[] = [];
  for (const line of text.matchAll(/[^\r\n]+/gu)) {
    const parts = pieces(line[0], maxTokens, countTokens);
    let first = 0;
    let offset = line.index;
    while (first < parts.length) {
      const last = fittingEnd(parts, first, maxTokens, countTokens);
      const joined = parts.slice(first, last).join("");
      const start = offset + joined.length - joined.trimStart().length;
      const end = offset + joined.trimEnd().length;
      if (start < end) chunks.push({ start, end, text: text.slice(start, end) });
      offset += joined.length;
      first = last;
    }
  }
  return chunks;
}

function fittingEnd(
  parts: string[],
  start: number,
  maxTokens: number,
  countTokens: CountTokens,
): number {
  const fits = (end: number) => countTokens(parts.slice(start, end).join("").trim()) <= maxTokens;
  let lo = start + 1;
  let hi = parts.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  const abbreviation = ABBREVIATION_END.exec(parts.slice(start, lo).join(""));
  if (abbreviation && lo < parts.length) {
    while (lo > start + 1 && parts.slice(start, lo).join("").length > abbreviation.index) lo--;
  }
  return lo;
}

export function stitch(
  raw: string,
  chunks: readonly Chunk[],
  outputs: readonly (string | undefined)[],
): string {
  const kept = chunks.flatMap((chunk, index) =>
    outputs[index] === "" ? [] : [{ index, chunk, output: outputs[index] }],
  );
  let text = "";
  kept.forEach(({ index, chunk, output }, k) => {
    const previous = kept[k - 1];
    const gap = previous ? separator(raw, chunks, previous.index, index) : "";
    text += gap;
    const omitted = previous ? raw.slice(previous.chunk.end, chunk.start) : "";
    const rawSentenceEnd =
      previous !== undefined &&
      (TERMINAL_END.test(previous.chunk.text) ||
        TERMINAL_END.test(omitted) ||
        SENTENCE_END.test(omitted));
    const continuation =
      previous !== undefined &&
      !/[\r\n]\s*$/u.test(text) &&
      !(gap && (TERMINAL_END.test(text) || rawSentenceEnd));
    text +=
      output === undefined
        ? chunk.text
        : continuation
          ? lowercaseContinuation(chunk.text, output)
          : output;
  });
  return text;
}

function separator(raw: string, chunks: readonly Chunk[], from: number, to: number): string {
  let selected = "";
  let lineBreaks = 0;
  for (let i = from + 1; i <= to; i++) {
    const gap = raw.slice(chunks[i - 1]!.end, chunks[i]!.start);
    const breaks = (gap.match(/\r\n|[\r\n]/gu) ?? []).length;
    if (breaks > lineBreaks || (breaks === lineBreaks && gap.length > selected.length)) {
      selected = gap;
      lineBreaks = breaks;
    }
  }
  return selected || (to - from > 1 ? " " : "");
}

const initialWord = (text: string) => /^[({[]*([\p{L}\p{N}'’]+)/u.exec(text);

function lowercaseContinuation(rawChunk: string, output: string): string {
  const rawWord = initialWord(rawChunk)?.[1];
  if (!rawWord || !/^\p{Ll}/u.test(rawWord) || rawWord === "i" || /^i['’]/.test(rawWord))
    return output;
  const cleaned = initialWord(output);
  if (cleaned?.[1] !== rawWord[0]!.toUpperCase() + rawWord.slice(1)) return output;
  const offset = cleaned[0].length - cleaned[1].length;
  return output.slice(0, offset) + output[offset]!.toLowerCase() + output.slice(offset + 1);
}

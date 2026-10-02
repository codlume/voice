type CountTokens = (text: string) => number;

const GRANULARITIES = ["sentence", "word", "grapheme"] as const;

function pieces(text: string, maxTokens: number, countTokens: CountTokens, level = 0): string[] {
  const granularity = GRANULARITIES[level] ?? "grapheme";
  const segments = Array.from(
    new Intl.Segmenter(undefined, { granularity }).segment(text),
    (s) => s.segment,
  );
  return segments.flatMap((segment) =>
    countTokens(segment.trim()) > maxTokens && level < GRANULARITIES.length - 1
      ? pieces(segment, maxTokens, countTokens, level + 1)
      : [segment],
  );
}

export function chunkTranscript(
  text: string,
  maxTokens: number,
  countTokens: CountTokens,
): string[] {
  const parts = pieces(text, maxTokens, countTokens);
  const chunks: string[] = [];
  let start = 0;
  while (start < parts.length) {
    const end = fittingEnd(parts, start, maxTokens, countTokens);
    chunks.push(parts.slice(start, end).join("").trim());
    start = end;
  }
  return chunks.filter(Boolean);
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
  return lo;
}

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
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces(text, maxTokens, countTokens)) {
    if (current && countTokens((current + piece).trim()) > maxTokens) {
      chunks.push(current.trim());
      current = "";
    }
    current += piece;
  }
  chunks.push(current.trim());
  return chunks.filter(Boolean);
}

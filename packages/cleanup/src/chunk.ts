const encoder = new TextEncoder();

// English runs about 4 UTF-8 bytes per Qwen3 token, accented and CJK text fewer, so bytes / 3 overestimates.
export function estimateTokens(text: string): number {
  return Math.ceil(encoder.encode(text).length / 3);
}

const GRANULARITIES = ["sentence", "word", "grapheme"] as const;

function pieces(text: string, maxTokens: number, level = 0): string[] {
  const granularity = GRANULARITIES[level] ?? "grapheme";
  const segments = Array.from(
    new Intl.Segmenter(undefined, { granularity }).segment(text),
    (s) => s.segment,
  );
  return segments.flatMap((segment) =>
    estimateTokens(segment.trim()) > maxTokens && level < GRANULARITIES.length - 1
      ? pieces(segment, maxTokens, level + 1)
      : [segment],
  );
}

// Packs whole sentences into chunks under `maxTokens`. Only a sentence that alone exceeds the
// limit is split, at word boundaries first and graphemes as a last resort.
export function chunkTranscript(text: string, maxTokens: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces(text, maxTokens)) {
    if (current && estimateTokens((current + piece).trim()) > maxTokens) {
      chunks.push(current.trim());
      current = "";
    }
    current += piece;
  }
  chunks.push(current.trim());
  return chunks.filter(Boolean);
}

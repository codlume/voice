import { describe, expect, test } from "vite-plus/test";

import { chunkTranscript, estimateTokens } from "./chunk.ts";

const words = (text: string) => text.split(/\s+/).filter(Boolean);

describe("chunkTranscript", () => {
  test("keeps a short transcript as one trimmed chunk", () => {
    expect(chunkTranscript("  Call Ada at 3 PM. Then email Bob.\n", 1000)).toEqual([
      "Call Ada at 3 PM. Then email Bob.",
    ]);
  });

  test("returns no chunks for empty or whitespace-only input", () => {
    expect(chunkTranscript("", 1000)).toEqual([]);
    expect(chunkTranscript(" \n\t ", 1000)).toEqual([]);
  });

  test("splits long input only between sentences", () => {
    const sentences = Array.from(
      { length: 40 },
      (_, i) => `Sentence number ${i + 1} talks about the October 12th beta, doesn't it?`,
    );
    const text = sentences.join(" ");

    const chunks = chunkTranscript(text, 60);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(60);
      expect(chunk).toMatch(/^Sentence number \d+ .*\?$/);
    }
    expect(chunks.join(" ")).toBe(text);
  });

  test("keeps a sentence that exactly fits the limit whole", () => {
    const sentence = "a".repeat(29) + ".";
    expect(estimateTokens(sentence)).toBe(10);
    expect(chunkTranscript(`${sentence} ${sentence}`, 10)).toEqual([sentence, sentence]);
  });

  test("splits an oversized unpunctuated sentence at word boundaries", () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");

    const chunks = chunkTranscript(text, 50);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(estimateTokens(chunk)).toBeLessThanOrEqual(50);
    expect(chunks.flatMap(words)).toEqual(words(text));
  });

  test("hard-splits a single word longer than the limit", () => {
    const url = `https://example.com/${"x".repeat(400)}`;

    const chunks = chunkTranscript(url, 20);

    for (const chunk of chunks) expect(estimateTokens(chunk)).toBeLessThanOrEqual(20);
    expect(chunks.join("")).toBe(url);
  });
});

describe("estimateTokens", () => {
  test("counts UTF-8 bytes so accented and CJK text is not underestimated", () => {
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("zażółć")).toBe(4);
    expect(estimateTokens("東京")).toBe(2);
  });
});

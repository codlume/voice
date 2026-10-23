import { expect, test } from "vite-plus/test";

import { budget } from "./budget.ts";

const model = { contextSize: 8192, maxWords: 1000 };
// The measured fixed prompt, without the text.
const FIXED = 364;
const plan = (words: number, textTokens: number) =>
  budget({ words, textTokens, promptTokens: FIXED + textTokens }, model);

test("a fitting text may produce twice its tokens plus the margin", () => {
  expect(plan(150, 180)).toEqual({ ok: true, maxTokens: 2 * 180 + 256 });
});

test("1,000 words of Polish fit, and the output cap stays inside the context", () => {
  const result = plan(1000, 1980);

  expect(result).toEqual({ ok: true, maxTokens: 2 * 1980 + 256 });
  expect(FIXED + 1980 + (result.ok ? result.maxTokens : 0)).toBeLessThanOrEqual(8192);
});

test("one word over the cap is too long, and the limit is the cap when the tokens would fit", () => {
  expect(plan(1001, 1200)).toEqual({ ok: false, maxWords: 1000 });
});

test("the token limit refuses a text that leaves no room for its rewrite, exactly at the context", () => {
  // FIXED + 3 × 2524 + 256 = 8192.
  expect(plan(900, 2524)).toEqual({ ok: true, maxTokens: 2 * 2524 + 256 });
  expect(plan(900, 2525).ok).toBe(false);
});

test("a text dense in tokens is told the word count that would fit at its own tokens per word", () => {
  // 3 tokens per word: (8192 - 364 - 256) / (3 × 3) = 841.3.
  expect(plan(1000, 3000)).toEqual({ ok: false, maxWords: 841 });
});

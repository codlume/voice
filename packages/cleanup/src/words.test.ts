import { describe, expect, test } from "vite-plus/test";

import { countWords } from "./words.ts";

describe("countWords", () => {
  test.each([
    ["", 0],
    ["   ", 0],
    ["one", 1],
    ["  two words ", 2],
    ["line\nbreaks\tand tabs", 4],
    ["Zażółć gęślą jaźń", 3],
    ["  Hi Anna,\n\nsee https://x.y/z — thanks.  ", 6],
  ])("%j has %i words", (text, words) => {
    expect(countWords(text)).toBe(words);
  });
});

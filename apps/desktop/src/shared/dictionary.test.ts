import { describe, expect, test } from "vite-plus/test";

import {
  PHRASE_MAX_LENGTH,
  REPLACEMENT_MAX_LENGTH,
  dictionaryProblem,
  parseDictionary,
  type DictionaryEntry,
} from "./dictionary.ts";
import type { Snippet } from "./snippets.ts";

let ids = 0;
const word = (phrase: string): DictionaryEntry => ({
  id: String((ids += 1)),
  phrase,
  replacement: null,
});
const replace = (phrase: string, replacement: string): DictionaryEntry => ({
  id: String((ids += 1)),
  phrase,
  replacement,
});

describe("dictionaryProblem", () => {
  const saved = [word("Wispr Flow"), replace("btw", "by the way")];
  const snippets: Snippet[] = [
    { id: "s", trigger: "my email", expansion: "a@example.com", enabled: true },
  ];
  const problem = (entry: DictionaryEntry) => dictionaryProblem(entry, saved, snippets);

  test.each([
    ["an empty phrase", word(""), "Enter a word or phrase."],
    ["a phrase with no letters or numbers", word("?!"), "Use at least one letter or number."],
    [
      "a phrase that is too long",
      word("a".repeat(PHRASE_MAX_LENGTH + 1)),
      `Use ${PHRASE_MAX_LENGTH} characters or fewer.`,
    ],
    [
      "a duplicate that differs only in case and spacing",
      word("WISPR   flow"),
      "This phrase is already in your dictionary.",
    ],
    [
      "a duplicate that differs only in accents",
      replace("btẁ", "bye"),
      "This phrase is already in your dictionary.",
    ],
    ["a snippet trigger", word("My Email"), "This phrase is already a snippet trigger."],
  ])("rejects %s", (_, entry, message) => {
    expect(problem(entry)).toEqual({ field: "phrase", message });
  });

  test.each([
    ["a blank replacement", replace("idk", "  "), "Enter the text Voice should type."],
    [
      "a replacement that is too long",
      replace("idk", "a".repeat(REPLACEMENT_MAX_LENGTH + 1)),
      `Use ${REPLACEMENT_MAX_LENGTH} characters or fewer.`,
    ],
  ])("rejects %s", (_, entry, message) => {
    expect(problem(entry)).toEqual({ field: "replacement", message });
  });

  test("accepts a word, a replacement, and the longest allowed phrase", () => {
    expect(problem(word("Hadryś"))).toBeNull();
    expect(problem(replace("idk", "I don't know"))).toBeNull();
    expect(problem(word("a".repeat(PHRASE_MAX_LENGTH)))).toBeNull();
    expect(problem(replace("x", "a".repeat(REPLACEMENT_MAX_LENGTH)))).toBeNull();
  });

  test("phrases that differ only in punctuation are separate entries, as they match separately", () => {
    expect(problem(word("wispr-flow!"))).toBeNull();
    expect(dictionaryProblem(word("email"), [replace("e-mail", "E")], [])).toBeNull();
    expect(dictionaryProblem(word("My E-mail"), [], snippets)).toBeNull();
  });
});

describe("parseDictionary", () => {
  test("keeps valid entries trimmed and drops malformed or invalid ones", () => {
    expect(
      parseDictionary([
        { id: "1", phrase: "  Wispr Flow ", replacement: null },
        { id: "2", phrase: "btw", replacement: " by the way " },
        { id: "3", phrase: "WISPR flow", replacement: null },
        { id: "1", phrase: "other", replacement: null },
        { id: "4", phrase: "missing replacement" },
        { id: "5", phrase: "", replacement: null },
        { id: "6", phrase: "idk", replacement: "" },
        { id: 7, phrase: "numeric id", replacement: null },
        "Wispr Flow",
        null,
      ]),
    ).toEqual([
      { id: "1", phrase: "Wispr Flow", replacement: null },
      { id: "2", phrase: "btw", replacement: "by the way" },
    ]);
  });

  test("returns nothing for a value that is not a list", () => {
    expect(parseDictionary({ 0: { id: "1", phrase: "x", replacement: null } })).toEqual([]);
    expect(parseDictionary(undefined)).toEqual([]);
  });
});

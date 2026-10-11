import { describe, expect, test } from "vite-plus/test";

import {
  PHRASE_MAX_LENGTH,
  REPLACEMENT_MAX_LENGTH,
  dictionaryEntry,
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

describe("dictionaryEntry", () => {
  test("trims the phrase and reads a blank replacement as a word", () => {
    expect(dictionaryEntry({ id: "1", phrase: "  Wispr Flow ", replacement: " \n " })).toEqual({
      id: "1",
      phrase: "Wispr Flow",
      replacement: null,
    });
    expect(dictionaryEntry({ id: "2", phrase: "btw", replacement: " by the way " })).toEqual({
      id: "2",
      phrase: "btw",
      replacement: "by the way",
    });
  });
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

  test("rejects a replacement that is too long", () => {
    expect(problem(replace("idk", "a".repeat(REPLACEMENT_MAX_LENGTH + 1)))).toEqual({
      field: "replacement",
      message: `Use ${REPLACEMENT_MAX_LENGTH} characters or fewer.`,
    });
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
        { id: "1", phrase: "other", replacement: null },
        { id: "4", phrase: "missing replacement" },
        { id: "5", phrase: "", replacement: null },
        { id: "6", phrase: "idk", replacement: 42 },
        { id: 7, phrase: "numeric id", replacement: null },
        "Wispr Flow",
        null,
      ]),
    ).toEqual([
      { id: "1", phrase: "Wispr Flow", replacement: null },
      { id: "2", phrase: "btw", replacement: "by the way" },
    ]);
  });

  test("an empty or blank replacement loads as a word, as the dialog saves one", () => {
    expect(
      parseDictionary([
        { id: "1", phrase: "btw", replacement: "" },
        { id: "2", phrase: "idk", replacement: "  " },
      ]),
    ).toEqual([
      { id: "1", phrase: "btw", replacement: null },
      { id: "2", phrase: "idk", replacement: null },
    ]);
  });

  test("two saved phrases the page would refuse as one both load", () => {
    const raw = [
      { id: "1", phrase: "Wispr Flow", replacement: null },
      { id: "2", phrase: "WISPR flow", replacement: null },
      { id: "3", phrase: "café", replacement: null },
      { id: "4", phrase: "cafe", replacement: "coffee" },
    ];
    expect(parseDictionary(raw).map((entry) => entry.id)).toEqual(["1", "2", "3", "4"]);
  });

  test("returns nothing for a value that is not a list", () => {
    expect(parseDictionary({ 0: { id: "1", phrase: "x", replacement: null } })).toEqual([]);
    expect(parseDictionary(undefined)).toEqual([]);
  });
});

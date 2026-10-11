import { describe, expect, test } from "vite-plus/test";

import {
  PHRASE_MAX_LENGTH,
  REPLACEMENT_MAX_LENGTH,
  applyDictionary,
  dictionaryProblem,
  parseDictionary,
  type DictionaryEntry,
} from "./dictionary.ts";
import { expandSnippets, type Snippet } from "./snippets.ts";

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

describe("applyDictionary", () => {
  test("a word is written with its saved casing wherever it appears", () => {
    expect(applyDictionary("I use wispr flow and WISPR FLOW daily.", [word("Wispr Flow")])).toBe(
      "I use Wispr Flow and Wispr Flow daily.",
    );
  });

  test("a word matches without its accents and gets them back", () => {
    const entries = [word("Hadryś"), word("café")];
    expect(applyDictionary("Mateusz hadrys met us at the cafe.", entries)).toBe(
      "Mateusz Hadryś met us at the café.",
    );
  });

  test("an accented transcript matches an entry saved without accents", () => {
    expect(applyDictionary("Zoë said hi", [word("Zoe")])).toBe("Zoe said hi");
  });

  test("a decomposed accent is replaced together with its letter", () => {
    const decomposed = "Hadryś wrote";
    expect(applyDictionary(decomposed, [word("Hadryś")])).toBe("Hadryś wrote");
  });

  test("text outside a match keeps its accents and form", () => {
    const text = "Zażółć gęślą jaźń, said hadrys, café au lait";
    expect(applyDictionary(text, [word("Hadryś")])).toBe(
      "Zażółć gęślą jaźń, said Hadryś, café au lait",
    );
  });

  test("letters that do not decompose are not folded", () => {
    expect(applyDictionary("We flew to Lodz.", [word("Łódź")])).toBe("We flew to Lodz.");
  });

  test("a lowercase word keeps the capital the transcript gave its first letter", () => {
    expect(applyDictionary("Voice is great. voice memos", [word("voice")])).toBe(
      "Voice is great. voice memos",
    );
    expect(applyDictionary("Cafe opens", [word("café")])).toBe("Café opens");
  });

  test("a word saved with any capital is written exactly as saved", () => {
    expect(applyDictionary("Iphone is here", [word("iPhone")])).toBe("iPhone is here");
  });

  test("a multi-word phrase matches across any run of whitespace", () => {
    expect(applyDictionary("try wispr   flow or wispr\n\tflow", [word("Wispr Flow")])).toBe(
      "try Wispr Flow or Wispr Flow",
    );
  });

  test("a replacement swaps the phrase for the saved text exactly", () => {
    expect(applyDictionary("BTW, ship it btw.", [replace("btw", "by the way")])).toBe(
      "by the way, ship it by the way.",
    );
  });

  test("the longest phrase wins an overlap, whatever the entry kind", () => {
    const entries = [word("Voice"), replace("voice app", "Voice for Mac")];
    expect(applyDictionary("the voice app beats voice memos", entries)).toBe(
      "the Voice for Mac beats Voice memos",
    );
  });

  test("a phrase never matches inside a longer word", () => {
    const entries = [word("Ana"), replace("btw", "by the way")];
    const text = "Banana and anagrams, btws";
    expect(applyDictionary(text, entries)).toBe(text);
  });

  test("a phrase never matches the start of a contraction", () => {
    const entries = [word("Don")];
    expect(applyDictionary("don't ask don", entries)).toBe("don't ask Don");
  });

  test("a replacement's output is never scanned again", () => {
    const entries = [replace("brb", "be right back"), replace("back", "WRONG")];
    expect(applyDictionary("brb", entries)).toBe("be right back");
  });

  test("no entries leaves the text untouched", () => {
    expect(applyDictionary("hello world", [])).toBe("hello world");
  });
});

describe("dictionary then snippets", () => {
  const snippets: Snippet[] = [
    { id: "s", trigger: "my link", expansion: "wispr flow and btw", enabled: true },
  ];
  const entries = [word("Wispr Flow"), replace("btw", "by the way"), word("LINK")];
  const pipeline = (text: string) => expandSnippets(applyDictionary(text, entries), snippets);

  test("a snippet expansion is never rewritten by the dictionary", () => {
    expect(pipeline("see my link, wispr flow").text).toBe("see wispr flow and btw, Wispr Flow");
  });

  test("a dictation that is only a trigger still types only the expansion", () => {
    expect(pipeline("My link.")).toEqual({
      text: "wispr flow and btw",
      count: 1,
      entireDictation: true,
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
    ["a duplicate word", word("wispr-flow!"), "This phrase is already in your dictionary."],
    [
      "a duplicate that differs only in accents",
      replace("btẁ", "bye"),
      "This phrase is already in your dictionary.",
    ],
    ["a snippet trigger", word("My E-mail"), "This phrase is already a snippet trigger."],
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

  test("drops snippet triggers only when snippets are given", () => {
    const raw = [{ id: "1", phrase: "my email", replacement: null }];
    const snippets: Snippet[] = [
      { id: "s", trigger: "My email", expansion: "a@example.com", enabled: true },
    ];
    expect(parseDictionary(raw)).toHaveLength(1);
    expect(parseDictionary(raw, snippets)).toEqual([]);
  });
});

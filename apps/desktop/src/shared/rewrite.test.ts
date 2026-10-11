import { describe, expect, test } from "vite-plus/test";

import type { DictionaryEntry } from "./dictionary.ts";
import { finalText, rewrite, type Rewrites } from "./rewrite.ts";
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
const snippet = (trigger: string, expansion: string, enabled = true): Snippet => ({
  id: String((ids += 1)),
  trigger,
  expansion,
  enabled,
});

const EMAIL = "name@example.com";
const email = snippet("my email", EMAIL);
const none = (text: string) => ({ text, snippets: 0, entireDictation: false });
const inside = (text: string, snippets: number) => ({ text, snippets, entireDictation: false });
const only = (text: string) => ({ text, snippets: 1, entireDictation: true });

// Dictionary alone: the rewritten text.
const fix = (text: string, dictionary: readonly DictionaryEntry[]) =>
  rewrite(text, { dictionary, snippets: [] }).text;
// Snippets alone.
const expand = (text: string, snippets: readonly Snippet[]) =>
  rewrite(text, { dictionary: [], snippets });

describe("rewrite with snippets", () => {
  test("a dictation that is only the trigger becomes the expansion alone", () => {
    for (const text of ["My email.", "my email", "  MY, Email!  ", "my-email?"]) {
      expect(expand(text, [email])).toEqual(only(EMAIL));
    }
  });

  test("a whole expansion keeps its own trailing newline", () => {
    const signature = snippet("sign off", "Best,\nAlex\n");
    expect(expand("Sign off.", [signature])).toEqual(only("Best,\nAlex\n"));
  });

  test("a trigger inside a sentence is replaced in place", () => {
    expect(expand("Send it to my email, please.", [email])).toEqual(
      inside(`Send it to ${EMAIL}, please.`, 1),
    );
  });

  test("every occurrence is replaced and counted, whatever its casing", () => {
    expect(expand("My email or my EMAIL, not my\nemail", [email])).toEqual(
      inside(`${EMAIL} or ${EMAIL}, not ${EMAIL}`, 3),
    );
  });

  test("a trigger never matches part of a word or a contraction", () => {
    const short = [snippet("email", EMAIL), snippet("don", "Don Draper")];
    const text = "Check the emails, don't wait, xemail";
    expect(expand(text, short)).toEqual(none(text));
    expect(expand("Ask don about the email", short)).toEqual(
      inside(`Ask Don Draper about the ${EMAIL}`, 2),
    );
  });

  test("the longest trigger wins an overlap", () => {
    const work = snippet("my email work", "work@example.com");
    expect(expand("Use my email work and my email", [email, work])).toEqual(
      inside(`Use work@example.com and ${EMAIL}`, 2),
    );
  });

  test("accented and non-Latin triggers match on word boundaries", () => {
    const snippets = [
      snippet("adres firmowy", "ul. Prosta 1"),
      snippet("café", "Café Nero"),
      snippet("моя почта", "ivan@example.com"),
    ];
    expect(expand("Mój adres firmowy i CAFÉ, нет cafés. Моя почта!", snippets)).toEqual(
      inside("Mój ul. Prosta 1 i Café Nero, нет cafés. ivan@example.com!", 3),
    );
  });

  test("a trigger matches without its accents, and an accented dictation matches a plain trigger", () => {
    expect(expand("un cafe noir", [snippet("café", "Café Nero")])).toEqual(
      inside("un Café Nero noir", 1),
    );
    expect(expand("Hadryś signs", [snippet("hadrys", "Mateusz Hadryś")])).toEqual(
      inside("Mateusz Hadryś signs", 1),
    );
  });

  test("a trigger ending in punctuation still matches between words", () => {
    expect(expand("Fruit, e.g. apples", [snippet("e.g.", "for example")])).toEqual(
      inside("Fruit, for example apples", 1),
    );
  });

  test("a trigger that starts or ends with punctuation never matches glued to a word", () => {
    expect(expand("wow!x and x.net", [snippet("wow!", "W"), snippet(".net", "dotnet")])).toEqual(
      none("wow!x and x.net"),
    );
  });

  test("an expansion is typed literally and never expanded again", () => {
    const loop = [snippet("alpha", "beta $& $1 \\n \\"), snippet("beta", "gamma")];
    expect(expand("say alpha now", loop)).toEqual(inside("say beta $& $1 \\n \\ now", 1));
  });

  test("whitespace and newlines in the expansion and the text are kept", () => {
    const address = snippet("address", "1 Main St\n  Springfield");
    expect(expand("Ship to:\n\taddress  today", [address])).toEqual(
      inside("Ship to:\n\t1 Main St\n  Springfield  today", 1),
    );
  });

  test("regex characters in a trigger match literally", () => {
    const plus = snippet("c++ (fast)", "C++ with -O3");
    expect(expand("use c++ (fast) here", [plus])).toEqual(inside("use C++ with -O3 here", 1));
    expect(expand("use cc (fast) here", [plus])).toEqual(none("use cc (fast) here"));
  });

  test("no match or no snippets leaves the text unchanged", () => {
    expect(expand("hello world", [email])).toEqual(none("hello world"));
    expect(expand("my email", [])).toEqual(none("my email"));
    expect(expand("...", [email])).toEqual(none("..."));
  });

  test("a match the regex folds wider than lowercase, such as a long s, is left alone", () => {
    expect(expand("please aſk now", [snippet("ask", "X")])).toEqual(none("please aſk now"));
  });

  test("a switched-off snippet never expands while a switched-on one beside it does", () => {
    const address = snippet("my address", "1 Main St", false);
    expect(expand("my address", [email, address])).toEqual(none("my address"));
    expect(expand("Send my address to my email", [email, address])).toEqual(
      inside(`Send my address to ${EMAIL}`, 1),
    );
  });
});

describe("rewrite with the dictionary", () => {
  test("a word is written with its saved casing wherever it appears", () => {
    expect(fix("I use wispr flow and WISPR FLOW daily.", [word("Wispr Flow")])).toBe(
      "I use Wispr Flow and Wispr Flow daily.",
    );
  });

  test("a word matches without its accents and gets them back", () => {
    const entries = [word("Hadryś"), word("café")];
    expect(fix("Mateusz hadrys met us at the cafe.", entries)).toBe(
      "Mateusz Hadryś met us at the café.",
    );
  });

  test("an accented transcript matches an entry saved without accents", () => {
    expect(fix("Zoë said hi", [word("Zoe")])).toBe("Zoe said hi");
  });

  test("a decomposed accent is replaced together with its letter", () => {
    expect(fix("Hadryś wrote", [word("Hadryś")])).toBe("Hadryś wrote");
  });

  test("text outside a match keeps its accents and form", () => {
    const text = "Zażółć gęślą jaźń, said hadrys, café au lait";
    expect(fix(text, [word("Hadryś")])).toBe("Zażółć gęślą jaźń, said Hadryś, café au lait");
  });

  test("letters that do not decompose are not folded", () => {
    expect(fix("We flew to Lodz.", [word("Łódź")])).toBe("We flew to Lodz.");
  });

  test("a lowercase word keeps the capital the transcript gave its first letter", () => {
    expect(fix("Voice is great. voice memos", [word("voice")])).toBe("Voice is great. voice memos");
    expect(fix("Cafe opens", [word("café")])).toBe("Café opens");
  });

  test("a word saved with any capital is written exactly as saved", () => {
    expect(fix("Iphone is here", [word("iPhone")])).toBe("iPhone is here");
  });

  test("a multi-word phrase matches across any run of whitespace", () => {
    expect(fix("try wispr   flow or wispr\n\tflow", [word("Wispr Flow")])).toBe(
      "try Wispr Flow or Wispr Flow",
    );
  });

  test("a replacement swaps the phrase for the saved text exactly", () => {
    expect(fix("BTW, ship it btw.", [replace("btw", "by the way")])).toBe(
      "by the way, ship it by the way.",
    );
  });

  test("the longest phrase wins an overlap, whatever the entry kind", () => {
    const entries = [word("Voice"), replace("voice app", "Voice for Mac")];
    expect(fix("the voice app beats voice memos", entries)).toBe(
      "the Voice for Mac beats Voice memos",
    );
  });

  test("a phrase never matches inside a longer word", () => {
    const entries = [word("Ana"), replace("btw", "by the way")];
    const text = "Banana and anagrams, btws";
    expect(fix(text, entries)).toBe(text);
  });

  test("a phrase never matches the start of a contraction", () => {
    expect(fix("don't ask don", [word("Don")])).toBe("don't ask Don");
  });

  test("a phrase ending in punctuation needs a word break after it", () => {
    const entries = [replace("U.S.", "United States"), replace("wow!", "W")];
    expect(fix("the U.S.A. team, wow!x", entries)).toBe("the U.S.A. team, wow!x");
    expect(fix("the U.S. team, wow! done", entries)).toBe("the United States team, W done");
  });

  test("a replacement's output is never scanned again", () => {
    const entries = [replace("brb", "be right back"), replace("back", "WRONG")];
    expect(fix("brb", entries)).toBe("be right back");
  });

  test("no entries leaves the text untouched", () => {
    expect(fix("hello world", [])).toBe("hello world");
  });
});

describe("rewrite with both lists", () => {
  const snippets = [snippet("my link", "wispr flow and btw"), snippet("btw thanks", "ta!")];
  const dictionary = [
    word("Wispr Flow"),
    replace("btw", "by the way"),
    word("LINK"),
    replace("idk", "see my link"),
    word("café"),
  ];
  const both: Rewrites = { dictionary, snippets };

  test("a snippet expansion is never rewritten by the dictionary", () => {
    expect(rewrite("see my link, wispr flow", both)).toEqual(
      inside("see wispr flow and btw, Wispr Flow", 1),
    );
  });

  test("a dictation that is only a trigger still types only the expansion", () => {
    expect(rewrite("My link.", both)).toEqual(only("wispr flow and btw"));
  });

  test("a replacement's text is typed as saved even when it contains a trigger", () => {
    expect(rewrite("idk", both)).toEqual(none("see my link"));
  });

  test("a snippet whose trigger contains a dictionary phrase still fires", () => {
    expect(rewrite("btw thanks for coming", both)).toEqual(inside("ta! for coming", 1));
    const menu: Rewrites = { dictionary, snippets: [snippet("cafe menu", "the menu")] };
    expect(rewrite("the cafe menu please", menu)).toEqual(inside("the the menu please", 1));
  });

  test("a snippet wins a trigger that is also a dictionary phrase", () => {
    const shadowed: Rewrites = {
      dictionary: [replace("my link", "nope")],
      snippets: [snippet("My Link", "yes")],
    };
    expect(rewrite("send my link now", shadowed)).toEqual(inside("send yes now", 1));
  });

  test("a switched-off snippet leaves the dictionary in charge of its words", () => {
    const off: Rewrites = { dictionary, snippets: [snippet("btw thanks", "ta!", false)] };
    expect(rewrite("btw thanks", off)).toEqual(none("by the way thanks"));
  });
});

describe("finalText", () => {
  const rewrites: Rewrites = { dictionary: [word("Hadryś")], snippets: [email] };

  test("prefers the cleaned text when it kept every trigger", () => {
    expect(finalText("send it to my email", "Send it to my email.", rewrites)).toBe(
      `Send it to ${EMAIL}.`,
    );
  });

  test("falls back to the raw transcript when cleanup lost a trigger", () => {
    expect(finalText("hadrys wants my email", "Hadrys wants it.", rewrites)).toBe(
      `Hadryś wants ${EMAIL}`,
    );
  });

  test("a switched-off snippet is ignored in both the raw and the cleaned text", () => {
    const off: Rewrites = { dictionary: [], snippets: [{ ...email, enabled: false }] };
    expect(finalText("my email", "My email.", off)).toBe("My email.");
  });

  test("returns nothing when cleanup emptied a transcript with no trigger", () => {
    expect(finalText("um", "", rewrites)).toBe("");
  });
});

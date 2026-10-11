import { describe, expect, test } from "vite-plus/test";

import {
  EXPANSION_MAX_LENGTH,
  TRIGGER_MAX_LENGTH,
  expandSnippets,
  parseSnippets,
  snippetProblem,
  snippetText,
  type Snippet,
} from "./snippets.ts";

const EMAIL = "name@example.com";
const snippet = (id: string, trigger: string, expansion: string): Snippet => ({
  id,
  trigger,
  expansion,
  enabled: true,
});
const email = snippet("1", "my email", EMAIL);
const none = (text: string) => ({ text, count: 0, entireDictation: false });

describe("expandSnippets", () => {
  test("a dictation that is only the trigger becomes the expansion alone", () => {
    for (const text of ["My email.", "my email", "  MY, Email!  ", "my-email?"]) {
      expect(expandSnippets(text, [email])).toEqual({
        text: EMAIL,
        count: 1,
        entireDictation: true,
      });
    }
  });

  test("a whole expansion keeps its own trailing newline", () => {
    const signature = snippet("1", "sign off", "Best,\nAlex\n");
    expect(expandSnippets("Sign off.", [signature])).toEqual({
      text: "Best,\nAlex\n",
      count: 1,
      entireDictation: true,
    });
  });

  test("a trigger inside a sentence is replaced in place", () => {
    expect(expandSnippets("Send it to my email, please.", [email])).toEqual({
      text: `Send it to ${EMAIL}, please.`,
      count: 1,
      entireDictation: false,
    });
  });

  test("every occurrence is replaced and counted, whatever its casing", () => {
    expect(expandSnippets("My email or my EMAIL, not my\nemail", [email])).toEqual({
      text: `${EMAIL} or ${EMAIL}, not ${EMAIL}`,
      count: 3,
      entireDictation: false,
    });
  });

  test("a trigger never matches part of a word or a contraction", () => {
    const short = [snippet("1", "email", EMAIL), snippet("2", "don", "Don Draper")];
    const text = "Check the emails, don't wait, xemail";
    expect(expandSnippets(text, short)).toEqual(none(text));
    expect(expandSnippets("Ask don about the email", short)).toEqual({
      text: `Ask Don Draper about the ${EMAIL}`,
      count: 2,
      entireDictation: false,
    });
  });

  test("the longest trigger wins an overlap", () => {
    const work = snippet("2", "my email work", "work@example.com");
    expect(expandSnippets("Use my email work and my email", [email, work])).toEqual({
      text: `Use work@example.com and ${EMAIL}`,
      count: 2,
      entireDictation: false,
    });
  });

  test("accented and non-Latin triggers match on word boundaries", () => {
    const snippets = [
      snippet("1", "adres firmowy", "ul. Prosta 1"),
      snippet("2", "café", "Café Nero"),
      snippet("3", "моя почта", "ivan@example.com"),
    ];
    expect(expandSnippets("Mój adres firmowy i CAFÉ, нет cafés. Моя почта!", snippets)).toEqual({
      text: "Mój ul. Prosta 1 i Café Nero, нет cafés. ivan@example.com!",
      count: 3,
      entireDictation: false,
    });
  });

  test("a trigger ending in punctuation still matches", () => {
    const eg = snippet("1", "e.g.", "for example");
    expect(expandSnippets("Fruit, e.g. apples", [eg])).toEqual({
      text: "Fruit, for example apples",
      count: 1,
      entireDictation: false,
    });
  });

  test("an expansion is typed literally and never expanded again", () => {
    const loop = [snippet("1", "alpha", "beta $& $1 \\n \\"), snippet("2", "beta", "gamma")];
    expect(expandSnippets("say alpha now", loop)).toEqual({
      text: "say beta $& $1 \\n \\ now",
      count: 1,
      entireDictation: false,
    });
  });

  test("whitespace and newlines in the expansion and the text are kept", () => {
    const address = snippet("1", "address", "1 Main St\n  Springfield");
    expect(expandSnippets("Ship to:\n\taddress  today", [address])).toEqual({
      text: "Ship to:\n\t1 Main St\n  Springfield  today",
      count: 1,
      entireDictation: false,
    });
  });

  test("regex characters in a trigger match literally", () => {
    const plus = snippet("1", "c++ (fast)", "C++ with -O3");
    expect(expandSnippets("use c++ (fast) here", [plus])).toEqual({
      text: "use C++ with -O3 here",
      count: 1,
      entireDictation: false,
    });
    expect(expandSnippets("use cc (fast) here", [plus])).toEqual(none("use cc (fast) here"));
  });

  test("no match or no snippets leaves the text unchanged", () => {
    expect(expandSnippets("hello world", [email])).toEqual(none("hello world"));
    expect(expandSnippets("my email", [])).toEqual(none("my email"));
    expect(expandSnippets("...", [email])).toEqual(none("..."));
  });

  test("a decomposed accent stays part of its word", () => {
    const text = "un cafe\u0301 noir";
    expect(expandSnippets(text, [snippet("1", "cafe", "X")])).toEqual(none(text));
  });

  test("a match the regex folds wider than lowercase, such as a long s, is left alone", () => {
    expect(expandSnippets("please aſk now", [snippet("1", "ask", "X")])).toEqual(
      none("please aſk now"),
    );
  });

  test("a switched-off snippet never expands while a switched-on one beside it does", () => {
    const address = { ...snippet("2", "my address", "1 Main St"), enabled: false };
    expect(expandSnippets("my address", [email, address])).toEqual(none("my address"));
    expect(expandSnippets("Send my address to my email", [email, address])).toEqual({
      text: `Send my address to ${EMAIL}`,
      count: 1,
      entireDictation: false,
    });
  });
});

describe("snippetText", () => {
  test("a switched-off snippet is ignored in both the raw and the cleaned text", () => {
    const off = { ...email, enabled: false };
    expect(snippetText("my email", "My email.", [off])).toBe("My email.");
  });
});

describe("snippetProblem", () => {
  test("a valid snippet has no problem beside other triggers", () => {
    expect(snippetProblem(email, [])).toBeNull();
    expect(snippetProblem(email, [snippet("2", "my address", "1 Main St")])).toBeNull();
  });

  test.each([
    ["", "trigger"],
    ["   ", "trigger"],
    ["?!", "trigger"],
    ["\u0301", "trigger"],
    ["\u0007", "trigger"],
    ["x".repeat(TRIGGER_MAX_LENGTH + 1), "trigger"],
  ] as const)("trigger %j is rejected", (trigger, field) => {
    expect(snippetProblem({ ...email, trigger }, [])?.field).toBe(field);
  });

  test.each(["", " \n\t ", "x".repeat(EXPANSION_MAX_LENGTH + 1)])(
    "expansion of length %# is rejected",
    (expansion) => {
      expect(snippetProblem({ ...email, expansion }, [])?.field).toBe("expansion");
    },
  );

  test("a trigger another snippet already uses, up to case and punctuation, is rejected", () => {
    const problem = snippetProblem(snippet("2", "My-Email!", "other"), [email]);
    expect(problem).toEqual({
      field: "trigger",
      message: "This trigger is already used by another snippet.",
    });
  });

  test("a switched-off snippet still holds its trigger", () => {
    const off = { ...email, enabled: false };
    expect(snippetProblem(snippet("2", "My Email", "other"), [off])?.message).toBe(
      "This trigger is already used by another snippet.",
    );
  });

  test("a message never repeats the expansion", () => {
    const secret = "s3cret-token ".repeat(400);
    expect(snippetProblem({ ...email, expansion: secret }, [])?.message).not.toContain("s3cret");
  });
});

describe("parseSnippets", () => {
  test("anything but an array reads as no snippets", () => {
    for (const raw of [undefined, null, "my email", { 0: email }]) {
      expect(parseSnippets(raw)).toEqual([]);
    }
  });

  test("valid records survive beside broken ones, with triggers trimmed and expansions verbatim", () => {
    const raw = [
      { id: "1", trigger: "  my email ", expansion: " name@example.com\n" },
      null,
      { id: "2", trigger: 5, expansion: "x" },
      { id: "3", trigger: "", expansion: "x" },
      { id: "4", trigger: "blank", expansion: "   " },
      { id: "5", trigger: "My Email.", expansion: "duplicate trigger" },
      { id: "1", trigger: "address", expansion: "duplicate id" },
      { id: "6", trigger: "address", expansion: "1 Main St" },
    ];
    expect(parseSnippets(raw)).toEqual([
      { id: "1", trigger: "my email", expansion: " name@example.com\n", enabled: true },
      { id: "6", trigger: "address", expansion: "1 Main St", enabled: true },
    ]);
  });

  test("a snippet saved before the switch reads as on, and a switched-off one stays off", () => {
    const raw = [
      { id: "1", trigger: "my email", expansion: EMAIL },
      { id: "2", trigger: "address", expansion: "1 Main St", enabled: false },
      { id: "3", trigger: "phone", expansion: "555", enabled: "no" },
    ];
    expect(parseSnippets(raw).map((s) => s.enabled)).toEqual([true, false, true]);
  });
});

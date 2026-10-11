import { describe, expect, test } from "vite-plus/test";

import {
  EXPANSION_MAX_LENGTH,
  TRIGGER_MAX_LENGTH,
  expandSnippets,
  parseSnippets,
  snippetProblem,
  type Snippet,
} from "./snippets.ts";

const EMAIL = "name@example.com";
const snippet = (id: string, trigger: string, expansion: string): Snippet => ({
  id,
  trigger,
  expansion,
});
const email = snippet("1", "my email", EMAIL);

describe("expandSnippets", () => {
  test("a dictation that is only the trigger becomes the expansion alone", () => {
    for (const text of ["My email.", "my email", "  MY, Email!  ", "my-email?"]) {
      expect(expandSnippets(text, [email])).toEqual({ kind: "entireDictation", text: EMAIL });
    }
  });

  test("a whole expansion keeps its own trailing newline", () => {
    const signature = snippet("1", "sign off", "Best,\nAlex\n");
    expect(expandSnippets("Sign off.", [signature])).toEqual({
      kind: "entireDictation",
      text: "Best,\nAlex\n",
    });
  });

  test("the first stored snippet wins a whole match tie", () => {
    const first = snippet("1", "my email", "first@example.com");
    const second = snippet("2", "my-email", "second@example.com");
    expect(expandSnippets("my email", [first, second])).toEqual({
      kind: "entireDictation",
      text: "first@example.com",
    });
  });

  test("a trigger inside a sentence is replaced in place", () => {
    expect(expandSnippets("Send it to my email, please.", [email])).toEqual({
      kind: "inline",
      text: `Send it to ${EMAIL}, please.`,
      count: 1,
    });
  });

  test("every occurrence is replaced and counted, whatever its casing", () => {
    expect(expandSnippets("My email or my EMAIL, not my\nemail", [email])).toEqual({
      kind: "inline",
      text: `${EMAIL} or ${EMAIL}, not ${EMAIL}`,
      count: 3,
    });
  });

  test("a trigger never matches part of a word or a contraction", () => {
    const short = [snippet("1", "email", EMAIL), snippet("2", "don", "Don Draper")];
    expect(expandSnippets("Check the emails, don't wait, xemail", short)).toEqual({
      kind: "none",
    });
    expect(expandSnippets("Ask don about the email", short)).toEqual({
      kind: "inline",
      text: `Ask Don Draper about the ${EMAIL}`,
      count: 2,
    });
  });

  test("the longest trigger wins an overlap", () => {
    const work = snippet("2", "my email work", "work@example.com");
    expect(expandSnippets("Use my email work and my email", [email, work])).toEqual({
      kind: "inline",
      text: `Use work@example.com and ${EMAIL}`,
      count: 2,
    });
  });

  test("accented and non-Latin triggers match on word boundaries", () => {
    const snippets = [
      snippet("1", "adres firmowy", "ul. Prosta 1"),
      snippet("2", "café", "Café Nero"),
      snippet("3", "моя почта", "ivan@example.com"),
    ];
    expect(expandSnippets("Mój adres firmowy i CAFÉ, нет cafés. Моя почта!", snippets)).toEqual({
      kind: "inline",
      text: "Mój ul. Prosta 1 i Café Nero, нет cafés. ivan@example.com!",
      count: 3,
    });
  });

  test("a trigger ending in punctuation still matches", () => {
    const eg = snippet("1", "e.g.", "for example");
    expect(expandSnippets("Fruit, e.g. apples", [eg])).toEqual({
      kind: "inline",
      text: "Fruit, for example apples",
      count: 1,
    });
  });

  test("an expansion is typed literally and never expanded again", () => {
    const loop = [snippet("1", "alpha", "beta $& $1 \\n \\"), snippet("2", "beta", "gamma")];
    expect(expandSnippets("say alpha now", loop)).toEqual({
      kind: "inline",
      text: "say beta $& $1 \\n \\ now",
      count: 1,
    });
  });

  test("whitespace and newlines in the expansion and the text are kept", () => {
    const address = snippet("1", "address", "1 Main St\n  Springfield");
    expect(expandSnippets("Ship to:\n\taddress  today", [address])).toEqual({
      kind: "inline",
      text: "Ship to:\n\t1 Main St\n  Springfield  today",
      count: 1,
    });
  });

  test("regex characters in a trigger match literally", () => {
    const plus = snippet("1", "c++ (fast)", "C++ with -O3");
    expect(expandSnippets("use c++ (fast) here", [plus])).toEqual({
      kind: "inline",
      text: "use C++ with -O3 here",
      count: 1,
    });
    expect(expandSnippets("use cc (fast) here", [plus])).toEqual({ kind: "none" });
  });

  test("no match or no snippets returns none", () => {
    expect(expandSnippets("hello world", [email])).toEqual({ kind: "none" });
    expect(expandSnippets("my email", [])).toEqual({ kind: "none" });
    expect(expandSnippets("...", [email])).toEqual({ kind: "none" });
  });
});

describe("snippetProblem", () => {
  test("a valid snippet has no problem, including when it is the one being edited", () => {
    expect(snippetProblem(email, [])).toBeNull();
    expect(snippetProblem({ ...email, expansion: "new@example.com" }, [email])).toBeNull();
  });

  test.each([
    ["", "trigger"],
    ["   ", "trigger"],
    ["?!", "trigger"],
    ["x".repeat(TRIGGER_MAX_LENGTH + 1), "trigger"],
  ] as const)("trigger %j is rejected", (trigger, field) => {
    expect(snippetProblem({ ...email, trigger }, [])?.field).toBe(field);
  });

  test("a trigger at the length limit, padded with spaces, is accepted", () => {
    expect(snippetProblem({ ...email, trigger: ` ${"x".repeat(TRIGGER_MAX_LENGTH)} ` }, [])).toBe(
      null,
    );
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
      { id: "1", trigger: "my email", expansion: " name@example.com\n" },
      { id: "6", trigger: "address", expansion: "1 Main St" },
    ]);
  });
});

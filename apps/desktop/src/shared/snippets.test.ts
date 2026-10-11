import { describe, expect, test } from "vite-plus/test";

import {
  EXPANSION_MAX_LENGTH,
  TRIGGER_MAX_LENGTH,
  parseSnippets,
  snippetProblem,
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

describe("snippetProblem", () => {
  test("a valid snippet has no problem beside other triggers", () => {
    expect(snippetProblem(email, [], [])).toBeNull();
    expect(snippetProblem(email, [snippet("2", "my address", "1 Main St")], [])).toBeNull();
  });

  test.each([
    ["", "trigger"],
    ["   ", "trigger"],
    ["?!", "trigger"],
    ["\u0301", "trigger"],
    ["\u0007", "trigger"],
    ["x".repeat(TRIGGER_MAX_LENGTH + 1), "trigger"],
  ] as const)("trigger %j is rejected", (trigger, field) => {
    expect(snippetProblem({ ...email, trigger }, [], [])?.field).toBe(field);
  });

  test.each(["", " \n\t ", "x".repeat(EXPANSION_MAX_LENGTH + 1)])(
    "expansion of length %# is rejected",
    (expansion) => {
      expect(snippetProblem({ ...email, expansion }, [], [])?.field).toBe("expansion");
    },
  );

  test("a trigger another snippet already uses, up to case, accents, and spacing, is rejected", () => {
    const taken = { field: "trigger", message: "This trigger is already used by another snippet." };
    expect(snippetProblem(snippet("2", "MY   Email", "other"), [email], [])).toEqual(taken);
    const cafe = snippet("3", "café", "Café Nero");
    expect(snippetProblem(snippet("4", "cafe", "other"), [cafe], [])).toEqual(taken);
    expect(snippetProblem(snippet("4", "CAFÉ", "other"), [cafe], [])).toEqual(taken);
  });

  test("a trigger that differs from another only in punctuation is accepted, as the pass tells them apart", () => {
    expect(snippetProblem(snippet("2", "my-email", "other"), [email], [])).toBeNull();
    expect(snippetProblem(snippet("2", "my email!", "other"), [email], [])).toBeNull();
  });

  test("a switched-off snippet still holds its trigger", () => {
    const off = { ...email, enabled: false };
    expect(snippetProblem(snippet("2", "My Email", "other"), [off], [])?.message).toBe(
      "This trigger is already used by another snippet.",
    );
  });

  test("a trigger that is a dictionary phrase is rejected, whatever its case, accents, or spacing", () => {
    const dictionary = [{ phrase: "Hadryś  signature" }];
    expect(snippetProblem(snippet("2", "hadrys SIGNATURE", ""), [], dictionary)).toEqual({
      field: "trigger",
      message: "This trigger is already in your dictionary.",
    });
  });

  test("a trigger that differs from a dictionary phrase only in punctuation is accepted", () => {
    expect(snippetProblem(snippet("2", "e-mail", "x"), [], [{ phrase: "email" }])).toBeNull();
  });

  test("a message never repeats the expansion", () => {
    const secret = "s3cret-token ".repeat(400);
    expect(snippetProblem({ ...email, expansion: secret }, [], [])?.message).not.toContain(
      "s3cret",
    );
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
      { id: "1", trigger: "address", expansion: "duplicate id" },
      { id: "6", trigger: "address", expansion: "1 Main St" },
    ];
    expect(parseSnippets(raw)).toEqual([
      { id: "1", trigger: "my email", expansion: " name@example.com\n", enabled: true },
      { id: "6", trigger: "address", expansion: "1 Main St", enabled: true },
    ]);
  });

  test("two saved triggers the page would refuse as one both load", () => {
    const raw = [
      { id: "1", trigger: "café", expansion: "Café Nero" },
      { id: "2", trigger: "cafe", expansion: "coffee" },
      { id: "3", trigger: "My Email.", expansion: "a@example.com" },
      { id: "4", trigger: "my email", expansion: "b@example.com" },
    ];
    expect(parseSnippets(raw).map(({ id }) => id)).toEqual(["1", "2", "3", "4"]);
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

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

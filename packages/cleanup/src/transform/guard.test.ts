import { readFileSync } from "node:fs";

import { describe, expect, test } from "vite-plus/test";

import { guard } from "./guard.ts";

// Inputs are the #312 spike's synthetic fixtures; outputs are what Gemma 4 E2B returned for them.
const recorded: { name: string; input: string; output: string; accepted: boolean }[] = JSON.parse(
  readFileSync(new URL("../../fixtures/transform-guard.json", import.meta.url), "utf8"),
);

const finished = { truncated: false, dictation: false as const };

describe("recorded outputs", () => {
  test.each(recorded)("$name: accepted $accepted", ({ input, output, accepted }) => {
    const verdict = guard(input, output, finished);

    expect(verdict).toEqual(
      accepted ? { ok: true, text: output.trim() } : { ok: false, reason: "endsEarly" },
    );
  });
});

const input =
  "so um the release moved to friday. anna will tell the customers. we keep the old pricing until may.";
const rewrite =
  "The release moved to Friday. Anna will tell the customers. We keep the old pricing until May.";

test("a legitimate rewrite comes back trimmed", () => {
  expect(guard(input, `\n${rewrite}\n\n`, finished)).toEqual({ ok: true, text: rewrite });
});

test("one wrapping <text> pair is stripped, and only one", () => {
  expect(guard(input, `<text>\n${rewrite}\n</text>`, finished)).toEqual({
    ok: true,
    text: rewrite,
  });
  expect(guard(input, `<text><text>${rewrite}</text></text>`, finished)).toEqual({
    ok: true,
    text: `<text>${rewrite}</text>`,
  });
});

test.each(["", "  \n ", "<text>\n</text>"])("an empty result %j is rejected", (output) => {
  expect(guard(input, output, finished)).toEqual({ ok: false, reason: "empty" });
});

test("a translation ending on a name from the first sentence is accepted, since its ending cannot be located", () => {
  const english = [
    "Marta Kowalska opened the new office on Monday.",
    "The building is an old printing works near the canal, with high ceilings and brick walls.",
    "Sound travels across the open floor, so the quiet room upstairs is for calls.",
    "Bicycles go in the courtyard, and the racks by the door are for visitors only.",
    "The kitchen has a new coffee machine, and the old kettle went to the basement.",
    "Access cards are at the front desk until the end of the month.",
  ].join(" ");
  const german =
    "Das neue Büro ist eröffnet. Zugangskarten liegen bis Monatsende am Empfang. Bei Fragen wendet euch bitte an Marta Kowalska.";

  expect(guard(english, german, finished)).toEqual({ ok: true, text: german });
});

test("a result cut off by the token cap is rejected, however complete it looks", () => {
  expect(guard(input, rewrite, { truncated: true, dictation: false })).toEqual({
    ok: false,
    reason: "truncated",
  });
});

test("a result that ends at the first of many sentences is rejected, and one that ends at the last is not", () => {
  const topics = [
    "pricing",
    "login",
    "release",
    "onboarding",
    "analytics",
    "billing",
    "hiring",
    "storage",
    "search",
  ];
  const long = topics.map((topic) => `The ${topic} team finished its ${topic} review.`).join(" ");

  expect(guard(long, "The pricing team finished its pricing review.", finished)).toEqual({
    ok: false,
    reason: "endsEarly",
  });
  expect(guard(long, "The search team finished its search review.", finished)).toEqual({
    ok: true,
    text: "The search team finished its search review.",
  });
  const bookended = `${long} The pricing team finished its pricing review.`;
  expect(guard(bookended, "The pricing team finished its pricing review.", finished).ok).toBe(true);
});

// Inputs are the cleanup calibration dictations; outputs are Gemma 4 E2B's Polish in dictation
// mode. `carriedOut` is a hand label: the output acted on a dictated command instead of keeping it.
const dictations: { name: string; input: string; output: string; carriedOut: boolean }[] =
  JSON.parse(
    readFileSync(new URL("../../fixtures/transform-dictations.json", import.meta.url), "utf8"),
  );
const rejectedCommands = new Set([
  "instruction-translate-spanish",
  "instruction-translate-german",
  "instruction-translate-french",
  "instruction-grammar",
  "instruction-commit",
  "instruction-shorter",
]);
const afterDictation = { truncated: false, dictation: { instructionKeepsWords: true } };

describe("after dictation", () => {
  test.each(dictations.filter((d) => !d.carriedOut))(
    "$name: a legitimate Polish is accepted",
    (dictated) => {
      expect(guard(dictated.input, dictated.output, afterDictation).ok).toBe(true);
    },
  );

  test.each(dictations.filter((d) => rejectedCommands.has(d.name)))(
    "$name: a carried-out command is rejected",
    (dictated) => {
      expect(guard(dictated.input, dictated.output, afterDictation)).toEqual({
        ok: false,
        reason: "lostOpening",
      });
    },
  );

  test("a translation outside dictation is accepted", () => {
    const german = dictations.find((d) => d.name === "instruction-translate-german");

    expect(german && guard(german.input, german.output, finished).ok).toBe(true);
  });

  test("a translation after dictation is accepted when the instruction itself rewrites the words", () => {
    const german = dictations.find((d) => d.name === "instruction-translate-german");
    const translating = { truncated: false, dictation: { instructionKeepsWords: false } };

    expect(german && guard(german.input, german.output, translating).ok).toBe(true);
  });
});

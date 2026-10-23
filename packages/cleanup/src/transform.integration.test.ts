import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import {
  createTransformEngine,
  type TransformEngine,
  type TransformRequest,
} from "./transform/index.ts";

const modelPath = process.env.VOICE_TRANSFORM_MODEL ?? "";

// The built-in Polish instruction, verbatim from #311.
const POLISH =
  "Polish this text. Make it more concise and easier to read: remove filler words, repetition and false starts, reword unclear sentences, and reorder sentences where that reads better. Add paragraph breaks or a list only where the text has separate points. Keep the author's tone and point of view, and keep every fact.";

const prose = (name: string) => {
  const recorded: { name: string; input: string }[] = JSON.parse(
    readFileSync(new URL("../fixtures/transform-guard.json", import.meta.url), "utf8"),
  );
  const found = recorded.find((entry) => entry.name === name);
  if (!found) throw new Error(`no fixture ${name}`);
  return found.input;
};

const request = (text: string, overrides: Partial<TransformRequest> = {}): TransformRequest => ({
  instruction: POLISH,
  text,
  dictation: false,
  budgetMs: 60_000,
  signal: new AbortController().signal,
  ...overrides,
});

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]{5,}/gu) ?? [];

// Share of the words only the last paragraph uses that the output keeps. Polish condenses, so a
// complete result keeps some of them; one that stopped early keeps none.
function lastParagraphCoverage(input: string, output: string): number {
  const paragraphs = input.split(/\n\s*\n/).filter((paragraph) => words(paragraph).length >= 20);
  const earlier = new Set(words(paragraphs.slice(0, -1).join("\n")));
  const distinct = [...new Set(words(paragraphs.at(-1) ?? ""))].filter((w) => !earlier.has(w));
  const kept = new Set(words(output));
  return distinct.filter((word) => kept.has(word)).length / distinct.length;
}

describe.skipIf(!modelPath)("Gemma 4 E2B transforms on the real model", () => {
  let engine: TransformEngine;

  beforeAll(async () => {
    engine = createTransformEngine({ modelPath });
    const start = performance.now();
    await engine.load();
    console.log(`[transform] load: ${Math.round(performance.now() - start)} ms`);
  }, 60_000);

  afterAll(() => engine?.dispose());

  test.each(["a Polish of a 650-word email", "a Polish of a 630-word letter"])(
    "%s keeps its last paragraph and passes the guard",
    async (name) => {
      const text = prose(name);
      const start = performance.now();
      const result = await engine.transform(request(text));
      const ms = Math.round(performance.now() - start);

      if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.failure)}`);
      const coverage = lastParagraphCoverage(text, result.text);
      console.log(
        `[transform] ${name}: ${ms} ms, ${text.split(/\s+/).length} -> ${result.text.split(/\s+/).length} words, last paragraph ${coverage.toFixed(2)}`,
      );
      expect(coverage).toBeGreaterThanOrEqual(1 / 3);
    },
    90_000,
  );

  test("abort rejects with the reason within a second, and the next run works", async () => {
    const controller = new AbortController();
    const running = engine.transform(
      request(prose("a Polish of a 630-word letter"), { signal: controller.signal }),
    );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const reason = new Error("cancelled by the user");
    const start = performance.now();
    controller.abort(reason);

    await expect(running).rejects.toBe(reason);
    const settledMs = Math.round(performance.now() - start);
    console.log(`[transform] abort settled in ${settledMs} ms`);
    expect(settledMs).toBeLessThan(1_000);

    const start2 = performance.now();
    const next = await engine.transform(
      request("so um we moved the launch to friday and anna will tell the customers"),
    );
    console.log(`[transform] next short run: ${Math.round(performance.now() - start2)} ms`);
    expect(next.ok).toBe(true);
  }, 90_000);

  test("a budget that runs out mid-generation resolves as timedOut", async () => {
    const result = await engine.transform(
      request(prose("a Polish of a 650-word email"), { budgetMs: 1_500 }),
    );

    expect(result).toEqual({ ok: false, failure: { kind: "timedOut" } });
  }, 30_000);

  test("a selection over the word cap is too long before anything is generated", async () => {
    const text = Array.from({ length: 1001 }, () => "word").join(" ");

    await expect(engine.transform(request(text))).resolves.toEqual({
      ok: false,
      failure: { kind: "tooLong", maxWords: 1000 },
    });
  });
});

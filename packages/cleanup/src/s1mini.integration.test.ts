import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { chunkTranscript } from "./chunk.ts";
import { MAX_OUTPUT_RATIO } from "./plausibility.ts";
import { buildS1MiniPrompt, type S1Control } from "./prompt.ts";
import type { CleanupStyle } from "./style.ts";
import { CHUNK_TOKENS, createS1Mini, type S1Mini } from "./s1mini.ts";

const modelPath = process.env.VOICE_S1_MODEL ?? "";
const formal: CleanupStyle = { style: "formal", layout: "general" };
const control: S1Control = { styling: "semi-formal", context: "general" };

describe.skipIf(!modelPath)("S1-mini on the real model", () => {
  let s1: S1Mini;

  const timed = async (name: string, raw: string, style: CleanupStyle) => {
    const start = performance.now();
    const result = await s1.clean(raw, style);
    console.log(
      `[s1-mini] ${name}: ${Math.round(performance.now() - start)} ms, ${result.cleaned}/${result.chunks} chunks -> ${JSON.stringify(result.text)}`,
    );
    return result;
  };

  beforeAll(async () => {
    s1 = createS1Mini({ modelPath });
    const start = performance.now();
    await s1.load();
    console.log(`[s1-mini] load: ${Math.round(performance.now() - start)} ms`);
  }, 60_000);

  afterAll(() => s1?.dispose());

  test("cases and punctuates plain lowercase speech", async () => {
    const { text } = await timed(
      "plain",
      "hey anna can we move the sync to thursday at three pm ill send the notes to the team",
      formal,
    );
    expect(text).toMatch(/^Hey Anna,/);
    expect(text).toContain("Thursday");
    expect(text).toContain("I'll send the notes");
    expect(text).toMatch(/[.!?]$/);
  });

  test("returns an empty string for filler-only speech", async () => {
    expect(await timed("filler", "um uh", formal)).toEqual({
      text: "",
      chunks: 1,
      cleaned: 1,
      queueMs: expect.any(Number),
      generateMs: expect.any(Number),
    });
  });

  test("cleans a transcript long enough to chunk, keeps both ends and every rejected chunk verbatim", async () => {
    const people = ["maria", "tom", "priya", "lukas", "sofia", "kenji"];
    const tasks = [
      "review the pricing page",
      "fix the login bug",
      "draft the release notes",
      "update the onboarding video",
      "check the analytics dashboard",
      "clean up the old feature flags",
      "call the design agency",
    ];
    const days = ["monday", "tuesday", "wednesday", "thursday", "friday"];
    const lines = Array.from(
      { length: 50 },
      (_, i) =>
        `${people[i % 6]} will ${tasks[i % 7]} by ${days[i % 5]} and send a short update to ${people[(i + 1) % 6]} before ${(i % 5) + 1} pm`,
    );
    const raw = `${lines.join(". ")}. and finally call ada on monday.`;
    const { getLlama } = await import("node-llama-cpp");
    const llama = await getLlama();
    const vocab = await llama.loadModel({ modelPath, vocabOnly: true });
    const chunks = chunkTranscript(raw, CHUNK_TOKENS, (text) => vocab.tokenize(text).length);
    await llama.dispose();
    expect(chunks.length).toBeGreaterThan(1);

    const result = await timed("chunked", raw, formal);

    expect(result.chunks).toBe(chunks.length);
    expect(result.cleaned).toBeGreaterThan(0);
    const verbatim = chunks.filter((chunk) => result.text.includes(chunk.text));
    expect(verbatim.length).toBeGreaterThanOrEqual(result.chunks - result.cleaned);
    expect(result.text).toMatch(/^Maria will review the pricing page by Monday/i);
    expect(result.text).toMatch(/Kenji/i);
    expect(result.text).toMatch(/Ada on Monday\.$/i);
  }, 60_000);

  test("full chunks of token-dense speech fit 2048 tokens with their whole output allowance", async () => {
    const speech = {
      unpunctuated: "the migration plan and the quarterly budget review ".repeat(120),
      polish: "żółć gęślą jaźń spotkanie zespół sprawozdanie wdrożenie ".repeat(120),
      cyrillic: "встреча завтра отчёт команда бюджет релиз пользователь ".repeat(120),
      chinese: "今天的会议讨论预算和发布计划明天继续".repeat(60),
      emoji: "🙂🚀🔥🎉💡".repeat(160),
      digits: "48213/7719 90211/3301 15877/6420 ".repeat(120),
    };
    const { getLlama } = await import("node-llama-cpp");
    const llama = await getLlama();
    const vocab = await llama.loadModel({ modelPath, vocabOnly: true });
    const countTokens = (text: string) => vocab.tokenize(text).length;

    for (const [name, raw] of Object.entries(speech)) {
      const chunks = chunkTranscript(raw, CHUNK_TOKENS, countTokens);
      const sizes = chunks.map((chunk) => countTokens(chunk.text));
      expect(Math.max(...sizes), name).toBeGreaterThan(0.9 * CHUNK_TOKENS);
      expect(Math.max(...sizes), name).toBeLessThanOrEqual(CHUNK_TOKENS);
      for (const [index, chunk] of chunks.entries()) {
        const prompt = vocab.tokenize(buildS1MiniPrompt(chunk.text, control), true).length;
        expect(prompt + MAX_OUTPUT_RATIO * sizes[index]! + 32, name).toBeLessThanOrEqual(2048);
      }
    }
    await llama.dispose();
  }, 60_000);

  test.each([
    ["inside the input cap", 1_200],
    ["past the 2048 input cap", 1_750],
    ["past the 4096 input cap", 2_300],
  ])(
    "a combining-mark grapheme %s stays verbatim",
    async (_, marks) => {
      const grapheme = `a${"\u0301\u0327\u0334\u0308".repeat(marks / 4)}`;

      const result = await s1.clean(`Hello there. ${grapheme} goodbye now.`, formal);

      expect(result.text).toContain(grapheme);
      expect(result.text).toMatch(/^Hello there\./);
      expect(result.text).toMatch(/goodbye now\.$/i);
      expect(result.cleaned).toBeLessThan(result.chunks);
    },
    60_000,
  );

  test("an emoji alone stays verbatim", async () => {
    expect(await timed("emoji", "🙂", formal)).toMatchObject({ text: "🙂", cleaned: 0 });
  });

  test("a full chunk whose output runs to the token cap comes back verbatim", async () => {
    const raw = "the ".repeat(390).trim();

    const [generation] = await s1.generate(raw, control);
    const result = await timed("token cap", raw, formal);

    expect(generation?.truncated).toBe(true);
    expect(result).toMatchObject({ text: raw, chunks: 1, cleaned: 0 });
  }, 60_000);
});

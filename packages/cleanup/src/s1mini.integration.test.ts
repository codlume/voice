import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { chunkTranscript } from "./chunk.ts";
import type { CleanupStyle } from "./prompt.ts";
import { CHUNK_TOKENS, createS1Mini, type S1Mini } from "./s1mini.ts";

const modelPath = process.env.VOICE_S1_MODEL ?? "";
const semiFormal: CleanupStyle = { styling: "semi-formal" };

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
      semiFormal,
    );
    expect(text).toMatch(/^Hey Anna,/);
    expect(text).toContain("Thursday");
    expect(text).toContain("I'll send the notes");
    expect(text).toMatch(/[.!?]$/);
  });

  test("returns an empty string for filler-only speech", async () => {
    expect(await timed("filler", "um uh", semiFormal)).toEqual({ text: "", chunks: 1, cleaned: 1 });
  });

  // The model drops too many words from one chunk of this repetitive fixture, so this is also the
  // proof that a chunk the guard rejects comes back as the user's exact words.
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

    const result = await timed("chunked", raw, semiFormal);

    expect(result.chunks).toBe(chunks.length);
    expect(result.cleaned).toBeGreaterThan(0);
    const verbatim = chunks.filter((chunk) => result.text.includes(chunk.text));
    expect(verbatim.length).toBeGreaterThanOrEqual(result.chunks - result.cleaned);
    expect(result.text).toMatch(/^Maria will review the pricing page by Monday/i);
    expect(result.text).toMatch(/Kenji/i);
    expect(result.text).toMatch(/Ada on Monday\.$/i);
  }, 60_000);
});

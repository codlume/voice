import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { CleanupStyle } from "./prompt.ts";
import { createS1Mini, type S1Mini } from "./s1mini.ts";

const modelPath = process.env.VOICE_S1_MODEL ?? "";
const semiFormal: CleanupStyle = { styling: "semi-formal" };

describe.skipIf(!modelPath)("S1-mini on the real model", () => {
  let s1: S1Mini;

  const timed = async (name: string, raw: string, style: CleanupStyle) => {
    const start = performance.now();
    const cleaned = await s1.clean(raw, style);
    console.log(
      `[s1-mini] ${name}: ${Math.round(performance.now() - start)} ms -> ${JSON.stringify(cleaned)}`,
    );
    return cleaned;
  };

  beforeAll(async () => {
    s1 = createS1Mini({ modelPath });
    const start = performance.now();
    await s1.load();
    console.log(`[s1-mini] load: ${Math.round(performance.now() - start)} ms`);
  }, 60_000);

  afterAll(() => s1?.dispose());

  test("cases and punctuates plain lowercase speech", async () => {
    const cleaned = await timed(
      "plain",
      "hey anna can we move the sync to thursday at three pm ill send the notes to the team",
      semiFormal,
    );
    expect(cleaned).toMatch(/^Hey Anna,/);
    expect(cleaned).toContain("Thursday");
    expect(cleaned).toContain("I'll send the notes");
    expect(cleaned).toMatch(/[.!?]$/);
  });

  test("returns an empty string for filler-only speech", async () => {
    expect(await timed("filler", "um uh", semiFormal)).toBe("");
  });

  test("cleans a transcript long enough to chunk and keeps both ends", async () => {
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
    const rawTokens = vocab.tokenize(raw).length;
    await llama.dispose();
    expect(rawTokens).toBeGreaterThan(1000);

    const cleaned = await timed("chunked", raw, semiFormal);

    expect(cleaned).toMatch(/^Maria will review the pricing page by Monday/);
    expect(cleaned).toContain("Kenji");
    expect(cleaned).toMatch(/Ada on Monday\.$/);
  }, 60_000);
});

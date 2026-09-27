import { ensureFixtures } from "../../../scripts/fixtures.mjs";
import { assert, dictateFixture, prepareAsr, withHelper } from "./helper.mjs";

const sessions = Number(process.env.SESSIONS ?? 3);
assert(Number.isInteger(sessions) && sessions > 0, "SESSIONS must be a positive integer");
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const cases = [
  { name: "short", words: ["Anna", "Thursday"] },
  { name: "long", words: ["migration", "15", "42,000", "2019", "tomorrow", "think"] },
];

ensureFixtures();
await withHelper({}, async (helper) => {
  await prepareAsr(helper);
  const results = [];
  for (let run = 0; run < sessions; run += 1) {
    for (const { name, words } of cases) {
      const eventsStart = helper.events.length;
      const { started, transcript, releaseToTranscriptMs } = await dictateFixture(
        helper,
        `${name}.wav`,
        `finalization-${name}-${run}`,
      );
      for (const word of words) {
        assert(transcript.text.includes(word), `${name} transcript lacks ${JSON.stringify(word)}`);
      }
      const streamed = helper
        .eventsSince(eventsStart)
        .some(
          (event) => event.type === "log" && event.message.startsWith("streaming ASR finalized "),
        );
      assert(name !== "short" || !streamed, "short dictation unexpectedly used streaming");
      if (process.env.EXPECT_STREAMING === "1") {
        assert(name !== "long" || streamed, "long dictation did not use streaming");
      }
      results.push({
        name,
        run,
        streamed,
        startMs: started.startMs,
        audioMs: transcript.audioMs,
        asrMs: transcript.asrMs,
        releaseToTranscriptMs,
        text: transcript.text,
      });
    }
  }
  console.log(
    JSON.stringify({
      binary: process.env.VOICE_HELPER_BIN ?? "debug build",
      medians: cases.map(({ name }) => ({
        name,
        releaseToTranscriptMs: median(
          results
            .filter((result) => result.name === name)
            .map((result) => result.releaseToTranscriptMs),
        ),
      })),
      sessions: results,
    }),
  );
});

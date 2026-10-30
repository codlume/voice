// Release-to-transcript latency per fixture. With BASELINE_BIN set, a second helper built from
// another commit runs beside the candidate and sessions alternate baseline, candidate, baseline...
// so background load on the machine lands on both; the report then also says whether the
// candidate's text matches the baseline's on every run.
import { ensureFixtures } from "../../../scripts/fixtures.mjs";
import { Helper, assert, dictateFixture, prepareAsr } from "./helper.mjs";

const sessions = Number(process.env.SESSIONS ?? 3);
assert(Number.isInteger(sessions) && sessions > 0, "SESSIONS must be a positive integer");
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const spread = (values) => [Math.min(...values), Math.max(...values)].map(Math.round);
const cases = [
  { name: "short", words: ["Anna", "Thursday"] },
  { name: "long", words: ["migration", "15", "42,000", "2019", "tomorrow", "think"] },
  { name: "url", words: ["github"] },
  { name: "pauses", words: ["Friday", "onboarding"] },
  { name: "boundary", words: ["Maria", "billing", "2026"] },
  { name: "language-trigger", language: "auto", words: ["Анна"] },
  { name: "silence", words: [], text: "" },
];
const only = process.env.FIXTURES?.split(",");
const selected = only ? cases.filter(({ name }) => only.includes(name)) : cases;
assert(selected.length > 0, `FIXTURES matched none of ${cases.map(({ name }) => name)}`);

ensureFixtures();
const helpers = { candidate: new Helper({}) };
if (process.env.BASELINE_BIN) {
  helpers.baseline = new Helper({ binary: process.env.BASELINE_BIN });
}
const results = [];
try {
  for (const helper of Object.values(helpers)) {
    await helper.waitForType("ready");
    await prepareAsr(helper);
  }
  for (let run = 0; run < sessions; run += 1) {
    for (const { name, words, language = "en", text } of selected) {
      for (const [binary, helper] of Object.entries(helpers).toReversed()) {
        const eventsStart = helper.events.length;
        const { started, transcript, releaseToTranscriptMs } = await dictateFixture(
          helper,
          `${name}.wav`,
          `finalization-${binary}-${name}-${run}`,
          language,
        );
        for (const word of words) {
          assert(
            transcript.text.toLowerCase().includes(word.toLowerCase()),
            `${name} transcript lacks ${JSON.stringify(word)}`,
          );
        }
        if (text !== undefined) {
          assert(
            transcript.text === text,
            `${name} transcript is ${JSON.stringify(transcript.text)}`,
          );
        }
        const logs = helper.eventsSince(eventsStart).filter((event) => event.type === "log");
        const streamed = logs.some((event) => event.message.startsWith("streaming ASR finalized "));
        assert(name !== "short" || !streamed, "short dictation unexpectedly used streaming");
        if (process.env.EXPECT_STREAMING === "1") {
          assert(name !== "long" || streamed, "long dictation did not use streaming");
        }
        results.push({
          binary,
          name,
          run,
          streamed,
          startMs: started.startMs,
          pressRelayMs: started.relayMs,
          audioMs: transcript.audioMs,
          releaseRelayMs: transcript.relayMs,
          asrMs: transcript.asrMs,
          releaseToTranscriptMs,
          text: transcript.text,
          asrLogs: logs.map((event) => event.message).filter((message) => message.includes("ASR")),
        });
      }
    }
  }
} finally {
  for (const helper of Object.values(helpers)) await helper.close();
}

const summary = selected.map(({ name }) => {
  const row = { name };
  const texts = {};
  for (const binary of Object.keys(helpers)) {
    const runs = results.filter((result) => result.binary === binary && result.name === name);
    texts[binary] = runs.map((result) => result.text);
    row[binary] = {
      releaseToTranscriptMs: median(runs.map((result) => result.releaseToTranscriptMs)),
      spread: spread(runs.map((result) => result.releaseToTranscriptMs)),
      texts: [...new Set(texts[binary])],
    };
  }
  if (helpers.baseline) {
    row.textMatchesBaseline = texts.candidate.every((text, i) => text === texts.baseline[i]);
  }
  return row;
});
console.log(
  JSON.stringify({
    binary: process.env.VOICE_HELPER_BIN ?? "debug build",
    baseline: process.env.BASELINE_BIN ?? null,
    summary,
    sessions: results,
  }),
);

// Transcription smoke: ready -> asr.prepare -> stream a fixture through test.audioFile -> transcript.
// Usage: node scripts/smoke.mjs   (runs short.wav and silence.wav)
import { assert, dictateFixture, prepareAsr, withHelper } from "./helper.mjs";

await withHelper({}, async (helper) => {
  const prepareMs = await prepareAsr(helper);

  const short = await dictateFixture(helper, "short.wav", "smoke-short");
  const text = short.transcript.text;
  assert(
    text.includes("Thursday"),
    `short.wav transcript lacks "Thursday": ${JSON.stringify(text)}`,
  );
  assert(text.includes("Anna"), `short.wav transcript lacks "Anna": ${JSON.stringify(text)}`);
  assert(short.levels.length >= 20, `short.wav produced only ${short.levels.length} level events`);
  assert(
    short.levels.every((level) => level >= 0 && level <= 1),
    `level outside 0..1: ${short.levels.find((level) => level < 0 || level > 1)}`,
  );
  const loudest = Math.max(...short.levels);
  assert(
    loudest >= 0.3 && loudest <= 1,
    `short.wav peak level ${loudest} is outside the speech band`,
  );
  assert(
    short.transcript.audioMs >= 4_500 && short.transcript.audioMs <= 5_500,
    `audioMs ${short.transcript.audioMs}`,
  );

  const silence = await dictateFixture(helper, "silence.wav", "smoke-silence");
  assert(
    silence.transcript.text === "",
    `silence.wav transcript is ${JSON.stringify(silence.transcript.text)}`,
  );
  assert(
    Math.max(...silence.levels) < 0.05,
    `silence.wav peak level ${Math.max(...silence.levels)}`,
  );

  console.log(
    JSON.stringify({
      prepareMs,
      short: {
        text,
        startMs: short.started.startMs,
        audioMs: short.transcript.audioMs,
        asrMs: short.transcript.asrMs,
        peakLevel: loudest,
      },
      silence: {
        text: silence.transcript.text,
        startMs: silence.started.startMs,
        audioMs: silence.transcript.audioMs,
        asrMs: silence.transcript.asrMs,
      },
    }),
  );
});

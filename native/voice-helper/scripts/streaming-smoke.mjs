import { ensureFixtures } from "../../../scripts/fixtures.mjs";
import { assert, dictateFixture, fixture, prepareAsr, withHelper } from "./helper.mjs";

ensureFixtures();
await withHelper({}, async (helper) => {
  await prepareAsr(helper);
  for (const stopFirst of [false, true]) {
    const id = stopFirst ? "cancel-finalization" : "cancel-recording";
    helper.send({ type: "test.audioFile", path: fixture("long.wav") });
    helper.send({
      type: "capture.start",
      microphone: null,
      id,
      language: "en",
      muteWhileDictating: false,
    });
    await helper.waitFor((event) => event.type === "capture.started" && event.id === id);
    await helper.waitFor(
      (event) =>
        event.type === "capture.level" &&
        event.id === id &&
        helper.events.filter((item) => item.type === "capture.level" && item.id === id).length >=
          140,
      { timeoutMs: 20_000, label: "14 seconds of fixture audio" },
    );
    if (stopFirst) helper.send({ type: "capture.stop", id });
    helper.send({ type: "capture.cancel", id });
    await helper.waitFor((event) => event.type === "capture.cancelled" && event.id === id);

    const next = await dictateFixture(helper, "short.wav", `${id}-next`);
    assert(next.transcript.text.includes("Thursday"), "the next session lost its transcript");
    assert(
      !helper.events.some(
        (event) => ["transcript", "transcript.failed"].includes(event.type) && event.id === id,
      ),
      "a cancelled session emitted a transcript",
    );
  }

  const streamEventsStart = helper.events.length;
  const auto = await dictateFixture(helper, "long.wav", "stream-auto", "auto");
  assert(
    helper
      .eventsSince(streamEventsStart)
      .some(
        (event) => event.type === "log" && event.message.startsWith("streaming ASR finalized "),
      ),
    "long dictation used batch fallback instead of streaming",
  );
  for (const word of ["migration", "15", "42,000", "2019", "tomorrow", "think"]) {
    assert(auto.transcript.text.includes(word), `auto transcript lacks ${JSON.stringify(word)}`);
  }
  const silence = await dictateFixture(helper, "silence.wav", "after-stream-silence");
  assert(silence.transcript.text === "", "silence reused an earlier transcript");
  console.log(
    JSON.stringify({
      cancelledRecording: true,
      cancelledFinalization: true,
      auto: true,
      silence: true,
    }),
  );
});

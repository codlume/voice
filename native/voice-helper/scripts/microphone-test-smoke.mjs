import { assert, fixture, withHelper } from "./helper.mjs";

const short = fixture("short.wav");
const silence = fixture("silence.wav");
const results = {};

const forId = (type, id) => (event) => event.type === type && event.id === id;
const indexOf = (helper, type, id) => helper.events.findIndex(forId(type, id));

await withHelper({ env: { VOICE_HELPER_TEST_AUDIO: short } }, async (helper) => {
  helper.send({ type: "microphone.test.start", id: "t1", microphone: null });
  await helper.waitFor(forId("microphone.test.started", "t1"), { label: "t1 started" });
  const loud = await helper.waitFor(
    (event) => forId("microphone.test.level", "t1")(event) && event.level > 0,
    { label: "t1 nonzero level" },
  );
  const started = indexOf(helper, "microphone.test.started", "t1");
  const firstLevel = indexOf(helper, "microphone.test.level", "t1");
  assert(started < firstLevel, "started precedes the first level");
  assert(
    !helper.events.some((event) => event.type.startsWith("capture.")),
    "a test emits no capture events",
  );

  helper.send({ type: "microphone.test.stop", id: "t1" });
  await helper.waitFor(forId("microphone.test.ended", "t1"), { label: "t1 ended" });
  const ended = indexOf(helper, "microphone.test.ended", "t1");
  helper.send({ type: "microphone.test.stop", id: "t1" });
  await helper.waitFor(
    (event) => event.type === "log" && event.message.includes("microphone.test.stop t1 ignored"),
    { label: "repeated stop is ignored" },
  );
  assert(
    !helper.eventsSince(ended + 1).some(forId("microphone.test.level", "t1")),
    "no level after ended",
  );
  assert(
    !helper.eventsSince(ended + 1).some(forId("microphone.test.ended", "t1")),
    "a repeated stop does not end twice",
  );
  results.stop = { nonzeroLevel: loud.level };

  helper.send({ type: "microphone.test.start", id: "t2", microphone: null });
  await helper.waitFor(forId("microphone.test.started", "t2"), { label: "t2 started" });
  helper.send({
    type: "capture.start",
    id: "s1",
    microphone: null,
    language: "en",
    muteWhileDictating: false,
  });
  await helper.waitFor(forId("capture.started", "s1"), { label: "s1 capture.started" });
  const preempted = indexOf(helper, "microphone.test.ended", "t2");
  const captured = indexOf(helper, "capture.started", "s1");
  assert(preempted !== -1 && preempted < captured, "dictation ends the test before it starts");

  helper.send({ type: "microphone.test.start", id: "t3", microphone: null });
  const busy = await helper.waitFor(forId("microphone.test.failed", "t3"), { label: "t3 failed" });
  assert(busy.message === "Finish dictating, then test again.", `busy message: ${busy.message}`);
  helper.send({ type: "capture.cancel", id: "s1" });
  await helper.waitFor(forId("capture.cancelled", "s1"), { label: "s1 cancelled" });
  results.preempt = { endedAt: preempted, capturedAt: captured };
});

await withHelper({ env: { VOICE_HELPER_TEST_AUDIO: silence } }, async (helper) => {
  helper.send({ type: "microphone.test.start", id: "t4", microphone: null });
  await helper.waitFor(forId("microphone.test.started", "t4"), { label: "t4 started" });
  await helper.waitFor(forId("microphone.test.ended", "t4"), { label: "t4 ended by file end" });
  const levels = helper.events.filter(forId("microphone.test.level", "t4"));
  assert(levels.length > 0, "silence still reports levels");
  assert(
    levels.every((event) => event.level === 0),
    "silence meters zero",
  );
  results.fileEnd = { levels: levels.length };
});

console.log(JSON.stringify({ results }));

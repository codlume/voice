import { assert, Helper } from "./helper.mjs";

// A terminal or IDE usually cannot get microphone access, so run it the way
// `pnpm dev` runs Electron, which answers for its own permission:
//   ELECTRON_RUN_AS_NODE=1 native/voice-helper/.build/debug/disclaim \
//     "$(cd apps/desktop && node -p 'require("electron")')" native/voice-helper/scripts/start-latency.mjs
const sessions = Number(process.env.SESSIONS ?? 10);
const userIdleGapMs = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];

const helper = new Helper({ env: { VOICE_HELPER_TEST: "0" } });
try {
  await helper.waitForType("ready");
  helper.send({ type: "permissions.check" });
  let { microphone } = await helper.waitForType("permissions");
  if (microphone === "notDetermined") {
    helper.send({ type: "permissions.request", kind: "microphone" });
    ({ microphone } = await helper.waitForType("permissions", {
      timeoutMs: 120_000,
      label: "a microphone permission answer",
    }));
  }
  assert(microphone === "granted", `microphone permission is ${microphone}`);

  const results = [];
  for (let index = 0; index < sessions; index += 1) {
    await sleep(userIdleGapMs);
    const id = `latency-${index}`;
    const sentAt = performance.now();
    helper.send({
      type: "capture.start",
      microphone: null,
      language: "en",
      id,
      muteWhileDictating: false,
    });
    const started = await helper.waitFor(
      (event) => ["capture.started", "capture.failed"].includes(event.type) && event.id === id,
      { label: "capture.started" },
    );
    assert(started.type === "capture.started", `capture.failed: ${started.message}`);
    const roundTripMs = performance.now() - sentAt;
    helper.send({ type: "capture.cancel", id });
    await helper.waitFor((event) => event.type === "capture.cancelled" && event.id === id, {
      label: "capture.cancelled",
    });
    results.push({ session: index + 1, startMs: started.startMs, roundTripMs });
  }

  const later = results.slice(1).map((result) => result.startMs);
  console.log(
    JSON.stringify({
      binary: process.env.VOICE_HELPER_BIN ?? "debug build",
      firstStartMs: results[0].startMs,
      medianStartMs: median(later),
      sessions: results,
    }),
  );
} finally {
  await helper.close();
}

import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, withHelper } from "./helper.mjs";

function audioState() {
  const state = execFileSync("osascript", ["-e", "get volume settings"], { encoding: "utf8" });
  const volume = Number(/output volume:(\d+)/.exec(state)?.[1]);
  const muted = /output muted:true/.test(state);
  assert(Number.isFinite(volume), `cannot read audio state: ${state}`);
  return { volume, muted };
}

function setMuted(muted) {
  execFileSync("osascript", ["-e", `set volume output muted ${muted}`]);
}

// The system volume reads back on a 0-100 scale rounded from each channel's scalar.
function expectState(expected, label, tolerance = 0) {
  const actual = audioState();
  assert(
    actual.muted === expected.muted,
    `${label}: mute ${actual.muted}, expected ${expected.muted}`,
  );
  assert(
    Math.abs(actual.volume - expected.volume) <= tolerance,
    `${label}: volume ${actual.volume}, expected ${expected.volume}`,
  );
  return actual;
}

const original = audioState();
const dir = await mkdtemp(join(tmpdir(), "voice-output-lowering-"));
const path = join(dir, "synthetic-silence.wav");
process.env.VOICE_TEST_MODELS_DIR = join(dir, "models");
const frames = 32_000;
const wav = Buffer.alloc(44 + frames * 2);
wav.write("RIFF");
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16_000, 24);
wav.writeUInt32LE(32_000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(frames * 2, 40);
await writeFile(path, wav);
const results = [];

const unchanged = (before) => before;
const muted = (before) => ({ ...before, muted: true });
const scaledBy = (scale) => (before) => ({
  ...before,
  volume: Math.round(before.volume * scale),
});

async function session(mode, { outputVolumeScale = 0, initiallyMuted = false, during: expected }) {
  setMuted(initiallyMuted);
  const before = audioState();
  const id = `lower-${mode}-${outputVolumeScale}-${initiallyMuted}`;
  const lowered = expected(before);
  let during;
  await withHelper({ env: { VOICE_HELPER_TEST_AUDIO: path } }, async (helper) => {
    helper.send({
      type: "capture.start",
      microphone: null,
      language: "en",
      id,
      outputVolumeScale,
      detectHost: false,
    });
    await helper.waitFor((event) => event.type === "capture.started" && event.id === id);
    during = expectState(lowered, `${mode} during capture`, 1);
    if (mode === "stop") {
      helper.send({ type: "capture.stop", id });
      await helper.waitFor((event) => event.type === "transcript" && event.id === id);
    } else if (mode === "cancel") {
      helper.send({ type: "capture.cancel", id });
      await helper.waitFor((event) => event.type === "capture.cancelled" && event.id === id);
    } else if (mode === "stale") {
      helper.send({ type: "capture.cancel", id: "stale" });
      await helper.waitFor(
        (event) => event.type === "log" && event.message.includes("capture.cancel stale ignored"),
      );
      helper.send({
        type: "capture.start",
        microphone: null,
        language: "en",
        id: "busy",
        outputVolumeScale: null,
        detectHost: false,
      });
      await helper.waitFor((event) => event.type === "capture.failed" && event.id === "busy");
      expectState(lowered, "stale and busy commands preserve active suppression", 1);
      helper.send({ type: "capture.cancel", id });
      await helper.waitFor((event) => event.type === "capture.cancelled" && event.id === id);
    } else if (mode === "sigterm") {
      helper.child.kill("SIGTERM");
      await helper.exited;
    } else {
      await helper.close();
    }
    expectState(before, `${mode} restored`);
  });
  const after = expectState(before, `${mode} after shutdown`);
  results.push({ mode, outputVolumeScale, initiallyMuted, before, during, after });
}

try {
  await session("stop", { outputVolumeScale: null, during: unchanged });
  await session("stop", { outputVolumeScale: 0.1, during: scaledBy(0.1) });
  await session("sigterm", { outputVolumeScale: 0.1, during: scaledBy(0.1) });
  await session("stop", { during: muted });
  await session("cancel", { during: muted });
  await session("stale", { during: muted });
  await session("eof", { during: muted });
  await session("sigterm", { during: muted });
  await session("stop", { initiallyMuted: true, during: muted });
  setMuted(false);
  const before = audioState();
  await withHelper(
    { env: { VOICE_HELPER_TEST_AUDIO: join(dir, "missing.wav") } },
    async (helper) => {
      helper.send({
        type: "capture.start",
        microphone: null,
        language: "en",
        id: "failure",
        outputVolumeScale: 0,
        detectHost: false,
      });
      await helper.waitFor((event) => event.type === "capture.failed" && event.id === "failure");
      expectState(before, "failed start leaves audio unchanged");
    },
  );
  results.push({ mode: "failed-start", restored: true });
  console.log(JSON.stringify({ results }));
} finally {
  if (audioState().volume !== original.volume) {
    execFileSync("osascript", ["-e", `set volume output volume ${original.volume}`]);
  }
  setMuted(original.muted);
  await rm(dir, { recursive: true, force: true });
  expectState(original, "original system audio restored");
}

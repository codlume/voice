#!/usr/bin/env node
// One repeatable before/after benchmark for the native helper:
//   node native/voice-helper/scripts/bench.mjs --baseline <voice-helper> --candidate <voice-helper>
//     [--runs N] [--only a,b] [--out file.json] [--fnpost <fnpost>] [--verbose]
// Sides alternate (baseline, candidate, baseline, ...) inside every metric, so load on the machine
// lands on both, and the side that goes first changes every run. The JSON report goes to stdout
// and a short table to stderr. Every measurement names the clock and the event pair it came from.
// Work that failed is counted in `errors` and never becomes a sample.
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, loadavg, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { ensureFixtures } from "../../../scripts/fixtures.mjs";
import { processIdentity, sameProcess, scratchPath } from "../../../scripts/smoke-resources.mjs";
import {
  USAGE,
  VERDICT_RULE,
  compareTranscripts,
  cpuSeconds,
  failures,
  finalizationPath,
  formatTable,
  measurement,
  missingAnchors,
  parseArgs,
  parseIntegrityLog,
  parseTimeOutput,
  round,
  topMemoryMb,
  wavDurationMs,
} from "./bench-report.mjs";
import {
  Helper,
  assert,
  dictateFixture,
  fixture,
  modelsDir,
  prepareAsr,
  runningVoiceProcesses,
} from "./helper.mjs";

const DEFAULT_RUNS = 5;
// A cold load compiles the model for the Neural Engine, which takes one to two minutes on a busy
// machine, so it gets fewer samples unless --runs asks for more.
const DEFAULT_COLD_RUNS = 3;
// The anchor words are the ones finalization-latency.mjs asserts for the same fixtures.
const FIXTURES = [
  { name: "short", words: ["Anna", "Thursday"] },
  { name: "pauses", words: ["Friday", "onboarding"] },
  { name: "boundary", words: ["Maria", "billing", "2026"] },
  { name: "url", words: ["github"] },
  // The decode its pause started is stale at release, so this one always pays a full decode.
  { name: "pause-then-speech", words: ["Friday", "Thanks"] },
  { name: "long", words: ["migration", "15", "42,000", "2019", "tomorrow", "think"] },
];
const EXCLUSIVE_WAIT_MS = 5 * 60_000;
const EXCLUSIVE_POLL_MS = 5_000;
// The helper prepares its audio engine again after each session and reports no event when it
// has, so a press follows the last one after the pause a person leaves, as in start-latency.mjs.
const MIC_IDLE_GAP_MS = 1_500;
const IDLE_SETTLE_MS = 10_000;
const IDLE_SAMPLE_MS = 20_000;
const IDLE_INTERVAL_MS = 1_000;
const TEXT_EDIT = "com.apple.TextEdit";
const CLIPBOARD_SEED = "voice-bench clipboard seed";
const INSERT_PREFIX = "voice-bench insert";
const DRIVER_CLOCK = "driver clock (Node performance.now)";
const HELPER_CLOCK = "helper clock (DispatchTime mach uptime)";
// CoreML keeps its compiled models under the home directory, in one cache for every process
// named voice-helper: the user's own Voice.app and other sessions' helpers. On a shared machine a
// load through it was cold again minutes after a warm one. The helpers here get a home of their
// own, so a warm load stays warm and that cache is neither read nor written. The home is kept
// between runs of one checkout, since filling it takes a minute or two.
const BENCH_HOME = scratchPath(
  "voice-bench-home",
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const E5RT_CACHE = "Library/Caches/voice-helper/com.apple.e5rt.e5bundlecache";

const execFileAsync = promisify(execFile);
const megabytes = (bytes) => bytes / 1024 / 1024;
const note = (message) => console.error(`[bench] ${message}`);

/** A metric that cannot run here. It is left out with the reason; it is not a failure. */
class Skip extends Error {}

const cleanups = [];

/** Registers an undo that runs once: from the caller's `finally`, or on a signal. */
function guard(cleanup) {
  const run = async () => {
    const index = cleanups.indexOf(run);
    if (index === -1) return;
    cleanups.splice(index, 1);
    return cleanup();
  };
  cleanups.push(run);
  return run;
}

async function runCleanups() {
  for (const run of cleanups.toReversed()) {
    await run().catch((error) => note(`cleanup failed: ${error.message}`));
  }
}

const ownHelpers = new Set();

function openHelper(side, { home = BENCH_HOME, env = {}, ...options } = {}) {
  const spawnedAt = performance.now();
  const helper = new Helper({
    binary: side.binary,
    trace: side.trace,
    env: { CFFIXED_USER_HOME: home, HOME: home, ...env },
    ...options,
  });
  ownHelpers.add(helper);
  // A command written to a helper that has died must not end the whole run: the event it
  // waited for never comes, and that sample is counted as failed.
  helper.child.stdin.on("error", () => {});
  const close = guard(async () => {
    const exit = await helper.close();
    ownHelpers.delete(helper);
    return exit;
  });
  return { helper, spawnedAt, close };
}

async function withSide(side, options, body) {
  const { helper, spawnedAt, close } = openHelper(side, options);
  try {
    await helper.waitForType("ready");
    return await body(helper, spawnedAt);
  } finally {
    await close();
  }
}

/** One loaded helper per side, alive together, for metrics whose sessions take turns. */
async function withEverySide(sides, options, body) {
  const helpers = new Map();
  const open = [];
  try {
    for (const side of sides) {
      const { helper, close } = openHelper(side, options);
      open.push(close);
      await helper.waitForType("ready");
      await prepareAsr(helper);
      helpers.set(side, helper);
    }
    return await body(helpers);
  } finally {
    for (const close of open.toReversed()) await close();
  }
}

/**
 * The order the sides take one run in. With a fixed order the second side decoded a short fixture
 * about 35 ms faster than the first, whichever binary it was.
 */
const taking = (sides, run) => (run % 2 === 0 ? sides : sides.toReversed());

function* eachRun(metric, runs) {
  for (let run = 0; run < runs; run += 1) {
    note(`${metric}: run ${run + 1} of ${runs}`);
    yield run;
  }
}

function arrival(helper, predicate) {
  const index = helper.events.findIndex(predicate);
  assert(index !== -1, `the helper never sent ${predicate}`);
  return helper.receivedAt[index];
}

const asrStatus = (state) => (event) => event.type === "asr.status" && event.state === state;

/** The grant belongs to the app that launched this script; this script never requests one. */
async function requirePermission(side, kind, env, consequence) {
  const state = await withSide(side, { env }, async (helper) => {
    helper.send({ type: "permissions.check" });
    return (await helper.waitForType("permissions"))[kind];
  });
  if (state !== "granted") {
    throw new Skip(
      `${kind} permission is ${state} for the app that launched this script, ${consequence}`,
    );
  }
}

function otherVoiceProcesses() {
  const own = new Set([...ownHelpers].map((helper) => String(helper.child.pid)));
  return runningVoiceProcesses()
    .map((line) => line.split(" ")[0])
    .filter((pid) => !own.has(pid));
}

/** For a metric that posts keys or moves focus: another Voice's hotkey tap would hear it. */
async function waitForExclusiveDesktop(metric) {
  const deadline = performance.now() + EXCLUSIVE_WAIT_MS;
  for (let waiting = false; ; waiting = true) {
    const others = otherVoiceProcesses();
    if (others.length === 0) return;
    if (performance.now() > deadline) {
      throw new Skip(
        `another Voice (pid ${others.join(", ")}) was still running after ${EXCLUSIVE_WAIT_MS / 60_000} minutes, and this metric posts keys and moves focus`,
      );
    }
    if (!waiting) note(`${metric}: waiting for another Voice (pid ${others.join(", ")}) to exit`);
    await sleep(EXCLUSIVE_POLL_MS);
  }
}

function assertExclusiveDesktop() {
  const others = otherVoiceProcesses();
  assert(
    others.length === 0,
    `another Voice started (pid ${others.join(", ")}); nothing was posted`,
  );
}

function recorder(sides, runs) {
  const values = {};
  const errors = Object.fromEntries(sides.map(({ name }) => [name, []]));
  const empty = () => Object.fromEntries(sides.map(({ name }) => [name, Array(runs).fill(null)]));
  return {
    errors,
    record(side, run, numbers) {
      for (const [key, value] of Object.entries(numbers)) {
        (values[key] ??= empty())[side.name][run] = value === null ? null : round(value);
      }
    },
    /** Runs one sample; a throw becomes a counted error and the sample stays null. */
    async attempt(side, run, context, body) {
      try {
        await body();
      } catch (error) {
        if (error instanceof Skip) throw error;
        note(`${side.name} run ${run} failed: ${error.message}`);
        errors[side.name].push({ run, ...context, message: error.message });
      }
    },
    measurements(specs) {
      return Object.fromEntries(
        Object.entries(specs)
          .filter(([key]) => values[key])
          .map(([key, spec]) => [key, measurement(spec, values[key])]),
      );
    },
  };
}

const bySide = (sides, make) => Object.fromEntries(sides.map(({ name }) => [name, make()]));

/** Every compiled model in a home's CoreML cache with its modification time. */
function compiledModels(home) {
  const root = join(home, E5RT_CACHE);
  if (!existsSync(root)) return "";
  return readdirSync(root, { recursive: true })
    .toSorted()
    .map((path) => `${path} ${statSync(join(root, String(path))).mtimeMs}`)
    .join("\n");
}

/** A sample that assumes a warm CoreML cache fails when CoreML had to compile during it. */
async function warmly(body) {
  const compiled = compiledModels(BENCH_HOME);
  const result = await body();
  assert(
    compiledModels(BENCH_HOME) === compiled,
    "CoreML compiled a model during this sample, so its cache was not warm",
  );
  return result;
}

async function timedLoad(side, options = {}) {
  return withSide(side, options, async (helper, spawnedAt) => {
    const readyAt = arrival(helper, (event) => event.type === "ready");
    const sentAt = performance.now();
    // download: true only lengthens the wait; priming already put every file in place.
    const prepareMs = await prepareAsr(helper, { download: true });
    assert(!helper.events.some(asrStatus("downloading")), "the load turned into a download");
    const audit = helper.events
      .filter((event) => event.type === "log")
      .map((event) => parseIntegrityLog(event.message))
      .find(Boolean);
    return {
      hashedBytes: audit?.hashedBytes ?? null,
      timings: {
        spawnToReadyMs: readyAt - spawnedAt,
        initAfterReadyMs: arrival(helper, asrStatus("loading")) - sentAt,
        prepareMs,
        spawnToAsrReadyMs: arrival(helper, asrStatus("ready")) - spawnedAt,
        integrityCheckMs: audit?.ms ?? null,
      },
    };
  });
}

const LOAD_SOURCES = {
  spawnToReadyMs: {
    unit: "ms",
    source: `${DRIVER_CLOCK}: spawn() called -> \`ready\` line parsed. A fresh process per sample. The helper writes \`ready\` before Helper.init runs, so this is process start and dyld only.`,
  },
  initAfterReadyMs: {
    unit: "ms",
    source: `${DRIVER_CLOCK}: \`asr.prepare\` sent on \`ready\` -> \`asr.status loading\`. The command waits in the pipe until Helper.init ends, so this is the start-up work that \`ready\` leaves out.`,
  },
  prepareMs: {
    unit: "ms",
    source: `${DRIVER_CLOCK}: \`asr.prepare\` sent on \`ready\` -> \`asr.status ready\` (helper.mjs prepareAsr). Covers the rest of Helper.init, the integrity check, four CoreML loads and the warm-up decode.`,
  },
  spawnToAsrReadyMs: {
    unit: "ms",
    source: `${DRIVER_CLOCK}: spawn() called -> \`asr.status ready\`. The whole launch; it does not move when work shifts across \`ready\`.`,
  },
  integrityCheckMs: {
    unit: "ms",
    source: `${HELPER_CLOCK}: the helper's own "speech model checked ... done in N ms" log line, whole milliseconds. Part of prepareMs.`,
  },
};

async function loadWarm({ sides, runs }) {
  const rec = recorder(sides, runs);
  const hashedBytes = bySide(sides, () => Array(runs).fill(null));
  for (const run of eachRun("load-warm", runs)) {
    for (const side of taking(sides, run)) {
      await rec.attempt(side, run, {}, async () => {
        const load = await warmly(() => timedLoad(side));
        hashedBytes[side.name][run] = load.hashedBytes;
        rec.record(side, run, load.timings);
      });
    }
  }
  return {
    conditions:
      "Integrity stamp and CoreML on-device cache warm: each binary loaded the model once before the first sample, and a load during which CoreML compiled anything is an error, not a sample.",
    // With the stamp in place the check hashes only the small files, a few megabytes.
    integrityCheckHashedBytes: hashedBytes,
    measurements: rec.measurements(LOAD_SOURCES),
    errors: rec.errors,
  };
}

// What main sends when a helper comes up (`configure` in apps/desktop/src/main/index.ts), in its
// order. `hotkey.configure` is left out: a configured tap would report keys other sessions post.
const LAUNCH_COMMANDS = [
  { type: "microphone.configure", microphone: null },
  { type: "permissions.check" },
  { type: "asr.prepare", download: false },
];
const isPermissions = (event) => event.type === "permissions";

async function launch({ sides, runs }) {
  const rec = recorder(sides, runs);
  for (const run of eachRun("launch", runs)) {
    for (const side of taking(sides, run)) {
      await rec.attempt(side, run, {}, async () => {
        const timings = await warmly(() =>
          withSide(side, {}, async (helper, spawnedAt) => {
            const sentAt = performance.now();
            for (const message of LAUNCH_COMMANDS) helper.send(message);
            const status = await helper.waitFor(
              (event) => event.type === "asr.status" && event.state !== "loading",
              { timeoutMs: 60_000, label: "asr.status ready" },
            );
            assert(status.state === "ready", `asr.status is ${status.state}`);
            assert(
              await until(() => helper.events.some(isPermissions), 5_000),
              "the helper never answered permissions.check",
            );
            return {
              loadingMs: arrival(helper, asrStatus("loading")) - sentAt,
              asrReadyMs: arrival(helper, asrStatus("ready")) - sentAt,
              permissionsMs: arrival(helper, isPermissions) - sentAt,
              spawnToAsrReadyMs: arrival(helper, asrStatus("ready")) - spawnedAt,
            };
          }),
        );
        rec.record(side, run, timings);
      });
    }
  }
  const sent = `${DRIVER_CLOCK}: ${LAUNCH_COMMANDS.map(({ type }) => `\`${type}\``).join(", ")} sent together on \`ready\``;
  return {
    conditions:
      "A fresh process per sample, sent what main sends at launch. Integrity stamp and CoreML cache warm, as in load-warm. Test mode, so `microphone.configure` builds no audio engine.",
    measurements: rec.measurements({
      loadingMs: {
        unit: "ms",
        source: `${sent} -> \`asr.status loading\`. The rest of Helper.init plus whatever the main thread does for the commands ahead of \`asr.prepare\`.`,
      },
      asrReadyMs: { unit: "ms", source: `${sent} -> \`asr.status ready\`.` },
      permissionsMs: { unit: "ms", source: `${sent} -> \`permissions\`.` },
      spawnToAsrReadyMs: {
        unit: "ms",
        source: `${DRIVER_CLOCK}: spawn() called -> \`asr.status ready\`.`,
      },
    }),
    errors: rec.errors,
  };
}

async function loadCold({ sides, runs }) {
  const rec = recorder(sides, runs);
  for (const run of eachRun("load-cold", runs)) {
    for (const side of taking(sides, run)) {
      const home = mkdtempSync(join(tmpdir(), "voice-bench-home-"));
      const removeHome = guard(() => rmSync(home, { recursive: true, force: true }));
      try {
        await rec.attempt(side, run, {}, async () => {
          const cold = await timedLoad(side, { home });
          if (compiledModels(home) === "") {
            throw new Skip(
              `CFFIXED_USER_HOME did not move CoreML's cache: no ${E5RT_CACHE} under the temporary home, and the real one is shared, so it is never deleted`,
            );
          }
          const reload = await timedLoad(side, { home });
          const [coldPrepareMs, reloadPrepareMs] = [cold, reload].map(
            ({ timings }) => timings.prepareMs,
          );
          assert(
            coldPrepareMs > reloadPrepareMs,
            `the cold load (${round(coldPrepareMs)} ms) was not slower than the reload after it (${round(reloadPrepareMs)} ms), so the cache was not cold`,
          );
          rec.record(side, run, {
            coldPrepareMs,
            coldSpawnToAsrReadyMs: cold.timings.spawnToAsrReadyMs,
            reloadPrepareMs,
          });
        });
      } finally {
        await removeHome();
      }
    }
  }
  return {
    conditions:
      "A fresh temporary home per sample, so CoreML's e5rt cache starts empty. The integrity stamp stays warm: the models directory is the shared one.",
    measurements: rec.measurements({
      coldPrepareMs: { unit: "ms", source: `${LOAD_SOURCES.prepareMs.source} Cold e5rt cache.` },
      coldSpawnToAsrReadyMs: {
        unit: "ms",
        source: `${LOAD_SOURCES.spawnToAsrReadyMs.source} Cold e5rt cache.`,
      },
      reloadPrepareMs: {
        unit: "ms",
        source: `${LOAD_SOURCES.prepareMs.source} The second load in the same temporary home, taken only to show the first one was cold. The system's Neural Engine daemon keeps a cache of its own that this cannot empty.`,
      },
    }),
    errors: rec.errors,
  };
}

async function fixtureSession(helper, { name, words }, id) {
  assert(helper.child.exitCode === null && helper.child.signalCode === null, "the helper exited");
  const from = helper.events.length;
  try {
    const { transcript, releaseToTranscriptMs } = await dictateFixture(helper, `${name}.wav`, id);
    const logs = helper
      .eventsSince(from)
      .filter((event) => event.type === "log")
      .map((event) => event.message);
    return {
      text: transcript.text,
      missing: missingAnchors(transcript.text, words),
      path: finalizationPath(logs),
      releaseToTranscriptMs,
      asrMs: transcript.asrMs,
      audioMs: transcript.audioMs,
      targetBundleId: transcript.target?.bundleId ?? null,
    };
  } catch (error) {
    // A session that died half-way would leave the helper busy for every later one.
    helper.send({ type: "capture.cancel", id });
    throw error;
  }
}

function assertAnchors(name, session) {
  assert(
    session.missing.length === 0,
    `${name} transcript lacks ${session.missing.join(", ")}: ${JSON.stringify(session.text)}`,
  );
}

async function finalization({ sides, runs }) {
  const rec = recorder(sides, runs);
  const perRun = () => bySide(sides, () => Array(runs).fill(null));
  const texts = Object.fromEntries(FIXTURES.map(({ name }) => [name, perRun()]));
  const paths = Object.fromEntries(FIXTURES.map(({ name }) => [name, perRun()]));
  await withEverySide(sides, {}, async (helpers) => {
    for (const run of eachRun("finalization", runs)) {
      for (const fixtureCase of FIXTURES) {
        const { name } = fixtureCase;
        for (const side of taking(sides, run)) {
          await rec.attempt(side, run, { fixture: name }, async () => {
            const id = `bench-${side.name}-${name}-${run}`;
            const session = await fixtureSession(helpers.get(side), fixtureCase, id);
            texts[name][side.name][run] = session.text;
            paths[name][side.name][run] = session.path;
            assertAnchors(name, session);
            rec.record(side, run, {
              [`${name}.releaseToTranscriptMs`]: session.releaseToTranscriptMs,
              [`${name}.asrMs`]: session.asrMs,
              [`${name}.audioMs`]: session.audioMs,
              [`${name}.realTimeFactor`]: session.asrMs / session.audioMs,
            });
          });
        }
      }
    }
  });

  const specs = {};
  const fixtures = {};
  for (const { name, words } of FIXTURES) {
    const taken = [...new Set(Object.values(paths[name]).flat().filter(Boolean))];
    const fullDecode = taken.length === 1 && taken[0] === "full decode";
    const pathNote = `Finalization path: ${taken.join(", ") || "none ran"}${taken.length > 1 ? " (mixed; bucket the samples by fixtures." + name + ".paths)" : ""}.`;
    specs[`${name}.releaseToTranscriptMs`] = {
      unit: "ms",
      source: `${DRIVER_CLOCK}: \`capture.stop\` sent after the fixture's last chunk -> \`transcript\` parsed (helper.mjs dictateFixture). ${pathNote}`,
    };
    specs[`${name}.asrMs`] = {
      unit: "ms",
      source: `${HELPER_CLOCK}: \`transcript.asrMs\`, entry to Transcriber.transcribe -> the decode returns. ${pathNote}`,
    };
    specs[`${name}.audioMs`] = {
      unit: "ms",
      source:
        "helper: `transcript.audioMs`, captured samples / 16 kHz. A length of audio, not elapsed time.",
    };
    specs[`${name}.realTimeFactor`] = {
      unit: "asrMs / audioMs",
      source: `\`transcript.asrMs\` / \`transcript.audioMs\`, both from the helper. ${pathNote}`,
      comparable: fullDecode,
      comparableNote: fullDecode
        ? "Every session was one full batch decode. A capture under 15 s is padded to one 15 s encoder pass, so this is mostly a fixed cost."
        : "Not a throughput figure: a reused pause decode makes asrMs near zero and a streamed session's asrMs covers only the tail.",
    };
    fixtures[name] = {
      anchors: words,
      paths: paths[name],
      texts: texts[name],
      accuracy: texts[name].baseline
        ? compareTranscripts(texts[name].baseline, texts[name].candidate)
        : null,
    };
  }
  const gates = Object.values(fixtures).map(({ accuracy }) => accuracy);
  return {
    conditions:
      "Both helpers stay loaded for the whole metric and take the sessions in turn; a fixture plays in real time. Test mode: the microphone is replaced by the fixture file.",
    accuracy: gates.every(Boolean)
      ? { matchesBaseline: gates.every((gate) => gate.matchesBaseline) }
      : null,
    fixtures,
    measurements: rec.measurements(specs),
    errors: rec.errors,
  };
}

/** Starts a capture and cancels it at its first audio, so nothing is kept or transcribed. */
async function startThenCancel(helper, id, hotkeyUptimeMs = null) {
  helper.send({
    type: "capture.start",
    id,
    microphone: null,
    language: "en",
    outputVolumeScale: null,
    detectHost: true,
    hotkeyUptimeMs,
  });
  const started = await helper.waitFor(
    (event) => ["capture.started", "capture.failed"].includes(event.type) && event.id === id,
    { label: "capture.started" },
  );
  assert(started.type === "capture.started", `capture.failed: ${started.message}`);
  helper.send({ type: "capture.cancel", id });
  await helper.waitFor((event) => event.type === "capture.cancelled" && event.id === id, {
    label: "capture.cancelled",
  });
  return started;
}

const isHotkey = (action) => (event) => event.type === "hotkey" && event.action === action;

async function hotkey({ sides, runs, fnpost }) {
  assert(fnpost, "no fnpost binary: pass --fnpost or put it next to a voice-helper binary");
  const rec = recorder(sides, runs);
  const post = (edge) => execFileAsync(fnpost, ["fn", edge]);

  async function press(helper, id) {
    const from = helper.events.length;
    assertExclusiveDesktop();
    const release = guard(() => post("up"));
    let started;
    try {
      // Awaiting fnpost here would hold the reply back by its 50 ms sleep after the event, so
      // its exit is awaited below; until then a failure must not count as unhandled.
      const posted = post("down");
      posted.catch(() => {});
      const down = await helper.waitFor(
        (event) => isHotkey("down")(event) && helper.events.indexOf(event) >= from,
        { timeoutMs: 3_000, label: "hotkey down" },
      );
      started = await startThenCancel(helper, id, down.uptimeMs);
      await posted;
    } finally {
      await release();
    }
    // Other input releases a synthetic hold early, so the helper may already have said `up`.
    if (!helper.eventsSince(from).some(isHotkey("up"))) {
      await helper.waitFor(isHotkey("up"), { timeoutMs: 3_000, label: "hotkey up" });
    }
    assert(typeof started.relayMs === "number", "capture.started carried no relayMs");
    return started;
  }

  await requirePermission(sides[0], "accessibility", {}, "so the helper has no hotkey tap");
  for (const run of eachRun("hotkey", runs)) {
    for (const side of taking(sides, run)) {
      await waitForExclusiveDesktop("hotkey");
      await rec.attempt(side, run, {}, () =>
        withSide(side, {}, async (helper) => {
          await prepareAsr(helper);
          assert(
            helper.events.some(
              (event) => event.type === "log" && event.message === "hotkey tap installed",
            ),
            "the helper did not install its hotkey tap",
          );
          helper.send({ type: "test.audioFile", path: fixture("silence.wav") });
          const first = await press(helper, `bench-hotkey-${side.name}-${run}-first`);
          const later = await press(helper, `bench-hotkey-${side.name}-${run}-later`);
          rec.record(side, run, {
            startMs: later.startMs,
            relayMs: later.relayMs,
            helperStartMs: later.startMs - later.relayMs,
            firstStartMs: first.startMs,
            firstRelayMs: first.relayMs,
          });
        }),
      );
    }
  }
  const path =
    "Fixture-file capture path: it excludes audio-device start, and the helper decodes the 2 s silence fixture inside capture.start instead.";
  return {
    conditions:
      "One helper alive at a time, a fresh one per sample, two presses each: the first press in a process and the one after it. fnpost posts a synthetic fn press that the helper's production event tap reports.",
    measurements: rec.measurements({
      startMs: {
        unit: "ms",
        source: `${HELPER_CLOCK}: \`capture.started.startMs\`, the tap callback's stamp of the fn press -> first audio chunk appended. Second press in the process. ${path}`,
      },
      relayMs: {
        unit: "ms",
        source: `${HELPER_CLOCK}: \`capture.started.relayMs\`, the tap callback's stamp -> \`capture.start\` read from stdin. The hop through this script, which stands in for the app's main process. Second press. Part of startMs.`,
      },
      helperStartMs: {
        unit: "ms",
        source: `${HELPER_CLOCK}: startMs - relayMs, \`capture.start\` read -> first audio chunk appended. Second press. ${path}`,
      },
      firstStartMs: {
        unit: "ms",
        source: `${HELPER_CLOCK}: \`capture.started.startMs\` for the first press in a fresh process. ${path}`,
      },
      firstRelayMs: {
        unit: "ms",
        source: `${HELPER_CLOCK}: \`capture.started.relayMs\` for the first press in a fresh process.`,
      },
    }),
    errors: rec.errors,
  };
}

async function micStart({ sides, runs }) {
  const rec = recorder(sides, runs);
  async function start(helper, id) {
    await sleep(MIC_IDLE_GAP_MS);
    return (await startThenCancel(helper, id)).startMs;
  }

  const env = { VOICE_HELPER_TEST: "0" };
  await requirePermission(
    sides[0],
    "microphone",
    env,
    "and this script never requests it. Run it from an app that holds the grant, as start-latency.mjs describes.",
  );
  for (const run of eachRun("mic-start", runs)) {
    for (const side of taking(sides, run)) {
      await rec.attempt(side, run, {}, () =>
        withSide(side, { env }, async (helper) => {
          helper.send({ type: "microphone.configure", microphone: null });
          await prepareAsr(helper);
          const firstStartMs = await start(helper, `bench-mic-${side.name}-${run}-first`);
          const startMs = await start(helper, `bench-mic-${side.name}-${run}-later`);
          rec.record(side, run, { startMs, firstStartMs });
        }),
      );
    }
  }
  const source = `${HELPER_CLOCK}: \`capture.started.startMs\`, \`capture.start\` read from stdin -> first audio chunk appended, on the real audio engine and the default input device (VOICE_HELPER_TEST=0). No hotkey is involved. \`capture.cancel\` follows at once, so the audio is discarded.`;
  return {
    conditions: `One helper alive at a time, a fresh one per sample, two sessions each, ${MIC_IDLE_GAP_MS} ms after the last activity so the engine is prepared again.`,
    measurements: rec.measurements({
      startMs: { unit: "ms", source: `${source} Second session in the process.` },
      firstStartMs: { unit: "ms", source: `${source} First session in a fresh process.` },
    }),
    errors: rec.errors,
  };
}

async function until(check, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (performance.now() > deadline) return false;
    await sleep(50);
  }
}

const PASTE_ROUTES = [
  { method: "accessibility", env: {} },
  { method: "paste", env: { VOICE_HELPER_FORCE_PASTE: "1" } },
];

async function paste({ sides, runs }) {
  await requirePermission(sides[0], "accessibility", {}, "so the helper cannot insert");
  await waitForExclusiveDesktop("paste");
  // Loaded here because it pulls in the app harness, which the other metrics do not need.
  const { clipboardKept, restoreClipboard, saveClipboard, textEditTarget } =
    await import("../../../scripts/targets.mjs");
  const rec = recorder(sides, runs);
  const routes = bySide(sides, () =>
    Object.fromEntries(PASTE_ROUTES.map(({ method }) => [method, Array(runs).fill(null)])),
  );
  const original = saveClipboard();
  let seeded;
  let clipboard = "untouched";
  // The user may copy something while this runs, so only this script's own strings are replaced.
  const giveClipboardBack = guard(() => {
    if (saveClipboard().digest === original.digest) return;
    const now = execFileSync("pbpaste", { encoding: "utf8" });
    const ours = now === CLIPBOARD_SEED || now.startsWith(INSERT_PREFIX);
    if (ours) restoreClipboard(original);
    clipboard = ours ? "restored" : "left as found: someone else changed it during the run";
  });
  const textEdit = textEditTarget("bench-paste");
  const closeTextEdit = guard(() => textEdit.close());

  let document;
  // targets.mjs gives its own read one second, which a loaded machine does not meet.
  const landed = (text) => () =>
    execFileAsync(
      "osascript",
      ["-e", `tell application "TextEdit" to get text of ${document.ref}`],
      { timeout: 10_000, killSignal: "SIGKILL" },
    ).then(
      ({ stdout }) => stdout.includes(text),
      () => false,
    );

  async function insert(helper, side, run, method) {
    const id = `bench-${method}-${side.name}-${run}`;
    assertExclusiveDesktop();
    await document.front();
    const session = await fixtureSession(helper, { name: "url", words: [] }, id);
    assert(session.text.trim() !== "", "the capture returned an empty transcript");
    assert(
      session.targetBundleId === TEXT_EDIT,
      "focus left TextEdit before the capture began, so nothing was inserted",
    );
    const text = `${INSERT_PREFIX} ${id} ${randomUUID()}`;
    const sentAt = performance.now();
    helper.send({ type: "insert", id, text: `${text}\n`, html: null, keepOnClipboard: false });
    const result = await helper.waitFor(
      (event) => event.type === "insert.result" && event.id === id,
      { label: "insert.result" },
    );
    const insertMs = arrival(helper, (event) => event === result) - sentAt;
    const took = `${result.method} ${result.route ?? result.reason}`;
    routes[side.name][method][run] = took;
    assert(result.method === method, `the helper took ${took}, not ${method}`);
    assert(
      await until(landed(text), 20_000),
      "the inserted text did not appear in the TextEdit document",
    );
    if (method === "paste") {
      assert(
        await clipboardKept(seeded, 10_000),
        "the clipboard did not return to its seeded contents",
      );
    }
    return {
      [`${method}.insertMs`]: insertMs,
      ...(method === "paste" ? { "paste.clipboardSaveMs": result.clipboardSaveMs } : {}),
    };
  }

  try {
    document = await textEdit.open();
    for (const { method, env } of PASTE_ROUTES) {
      if (method === "paste") {
        execFileSync("pbcopy", { input: CLIPBOARD_SEED });
        seeded = saveClipboard();
      }
      await withEverySide(sides, { env }, async (helpers) => {
        for (const run of eachRun(`paste (${method})`, runs)) {
          for (const side of taking(sides, run)) {
            await waitForExclusiveDesktop("paste");
            await rec.attempt(side, run, { method }, async () => {
              rec.record(side, run, await insert(helpers.get(side), side, run, method));
            });
          }
        }
      });
    }
  } finally {
    await closeTextEdit();
    await giveClipboardBack();
  }
  const target =
    "Target: a TextEdit document this script opened, frontmost since before the fixture capture that gives the insert its target. The text was read back from the document afterwards.";
  return {
    conditions: `Both helpers stay alive per route and take the inserts in turn, so run 0 is each process's first insert. The paste route is forced with VOICE_HELPER_FORCE_PASTE=1, and the clipboard holds a known ${CLIPBOARD_SEED.length}-byte string while it runs.`,
    routes,
    clipboard,
    measurements: rec.measurements({
      "accessibility.insertMs": {
        unit: "ms",
        source: `${DRIVER_CLOCK}: \`insert\` sent -> \`insert.result\` parsed, method accessibility: the helper made the write and read it back. ${target}`,
      },
      "paste.insertMs": {
        unit: "ms",
        source: `${DRIVER_CLOCK}: \`insert\` sent -> \`insert.result\` parsed, method paste. The result marks Cmd+V posted, not the text landing, and the clipboard restore a second later is outside it. ${target}`,
      },
      "paste.clipboardSaveMs": {
        unit: "ms",
        source: `${HELPER_CLOCK}: \`insert.result.clipboardSaveMs\`, around saving the clipboard before the paste. Part of paste.insertMs. The clipboard held this script's seed string.`,
      },
    }),
    errors: rec.errors,
  };
}

async function idleSample(pid) {
  const readings = [];
  const startedAt = performance.now();
  for (let tick = 0; tick <= IDLE_SAMPLE_MS / IDLE_INTERVAL_MS; tick += 1) {
    await sleep(Math.max(0, startedAt + tick * IDLE_INTERVAL_MS - performance.now()));
    const [rss, time] = execFileSync("ps", ["-o", "rss=,time=", "-p", String(pid)], {
      encoding: "utf8",
    })
      .trim()
      .split(/\s+/);
    readings.push({ at: performance.now(), rssKb: Number(rss), cpuS: cpuSeconds(time) });
  }
  const [first, last] = [readings[0], readings.at(-1)];
  const top = execFileSync("top", ["-l", "1", "-pid", String(pid), "-stats", "mem"], {
    encoding: "utf8",
  });
  return {
    idleRssMb: readings.reduce((sum, { rssKb }) => sum + rssKb, 0) / readings.length / 1024,
    idleFootprintMb: topMemoryMb(top.trim().split("\n").at(-1)),
    idleCpuPercent: ((last.cpuS - first.cpuS) / ((last.at - first.at) / 1000)) * 100,
  };
}

async function footprint({ sides, runs }) {
  const rec = recorder(sides, runs);
  for (const run of eachRun("footprint", runs)) {
    for (const side of taking(sides, run)) {
      await rec.attempt(side, run, {}, async () => {
        const usage = await warmly(async () => {
          const { helper, close } = openHelper(side, {
            launcher: ["/usr/bin/time", "-l"],
            stderr: "pipe",
          });
          let stderr = "";
          helper.child.stderr?.on("data", (chunk) => (stderr += chunk));
          let stopOrphan;
          let idle;
          try {
            await helper.waitForType("ready");
            const pid = Number(
              execFileSync("pgrep", ["-P", String(helper.child.pid)], { encoding: "utf8" }).trim(),
            );
            const identity = processIdentity(pid);
            // Closing stdin ends the helper; a kill would reach only `time`, its parent.
            stopOrphan = guard(() => {
              if (sameProcess(pid, identity)) process.kill(pid, "SIGKILL");
            });
            await prepareAsr(helper);
            await sleep(IDLE_SETTLE_MS);
            idle = await idleSample(pid);
            for (const fixtureCase of FIXTURES) {
              const id = `bench-footprint-${side.name}-${fixtureCase.name}-${run}`;
              assertAnchors(fixtureCase.name, await fixtureSession(helper, fixtureCase, id));
            }
          } finally {
            const exit = await close();
            await stopOrphan?.();
            assert(exit.code === 0, `the helper exited with ${JSON.stringify(exit)}: ${stderr}`);
          }
          const atExit = parseTimeOutput(stderr);
          return {
            ...idle,
            peakRssMb: megabytes(atExit.maxRssBytes),
            peakFootprintMb: megabytes(atExit.peakFootprintBytes),
            cpuSeconds: atExit.userS + atExit.sysS,
          };
        });
        rec.record(side, run, usage);
      });
    }
  }
  const work = `one process: launch, model load, ${(IDLE_SETTLE_MS + IDLE_SAMPLE_MS) / 1000} s idle, then ${FIXTURES.map(({ name }) => name).join(", ")} dictated once each, then exit`;
  const idle = `after the model loaded and ${IDLE_SETTLE_MS / 1000} s of settling. Test mode, so no audio engine is prepared as it is in the app.`;
  return {
    conditions: `One helper alive at a time, a fresh one per sample, run under /usr/bin/time -l. Each sample is ${work}. Every transcript was checked for its anchor words, and a sample during which CoreML compiled anything is an error.`,
    measurements: rec.measurements({
      idleRssMb: {
        unit: "MiB",
        source: `ps rss, mean of ${IDLE_SAMPLE_MS / IDLE_INTERVAL_MS + 1} readings ${IDLE_INTERVAL_MS / 1000} s apart, ${idle} Resident memory falls when the system is short of memory, whatever the helper does; idleFootprintMb does not.`,
      },
      idleFootprintMb: {
        unit: "MiB",
        source: `top MEM column (the kernel's phys_footprint, which counts compressed and swapped pages), one reading at the end of the idle window, ${idle}`,
      },
      idleCpuPercent: {
        unit: "% of one core",
        source: `ps cumulative CPU time (0.01 s steps), growth over ${IDLE_SAMPLE_MS / 1000} s of ${DRIVER_CLOCK}, ${idle}`,
      },
      peakRssMb: {
        unit: "MiB",
        source: `/usr/bin/time -l "maximum resident set size" (rusage ru_maxrss) at exit, over ${work}.`,
      },
      peakFootprintMb: {
        unit: "MiB",
        source: `/usr/bin/time -l "peak memory footprint" (the kernel's phys_footprint high-water mark) at exit, over ${work}.`,
      },
      cpuSeconds: {
        unit: "s",
        source: `/usr/bin/time -l user + sys at exit, over ${work}. The helper process only: CoreML work done in system daemons is not in it.`,
      },
    }),
    errors: rec.errors,
  };
}

const RUNNERS = {
  "load-warm": loadWarm,
  launch,
  "load-cold": loadCold,
  finalization,
  hotkey,
  "mic-start": micStart,
  paste,
  footprint,
};

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function command(file, args) {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function environment(sides, fnpost) {
  const models = modelsDir();
  const power = command("pmset", ["-g", "batt"]);
  return {
    chip: command("sysctl", ["-n", "machdep.cpu.brand_string"]),
    cores: cpus().length,
    performanceCores: Number(command("sysctl", ["-n", "hw.perflevel0.physicalcpu"])) || null,
    ramBytes: totalmem(),
    macos: {
      version: command("sw_vers", ["-productVersion"]),
      build: command("sw_vers", ["-buildVersion"]),
    },
    swift: command("swift", ["--version"])?.replaceAll("\n", " | ") ?? null,
    node: process.version,
    power: power && /'([^']+)'/.exec(power)?.[1],
    binaries: {
      ...Object.fromEntries(
        sides.map(({ name, binary }) => [name, { path: binary, sha256: sha256(binary) }]),
      ),
      ...(fnpost ? { fnpost: { path: fnpost, sha256: sha256(fnpost) } } : {}),
    },
    helperHome: BENCH_HOME,
    modelsDir: models,
    asrModelFolder:
      readdirSync(models).find((name) => existsSync(join(models, name, "Encoder.mlmodelc"))) ??
      null,
    loadAverage: { start: loadavg().map(round), end: null },
    fixtures: [...FIXTURES.map(({ name }) => name), "silence"].map((name) => {
      const bytes = readFileSync(fixture(`${name}.wav`));
      return {
        name: `${name}.wav`,
        durationMs: wavDurationMs(bytes),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  };
}

/** Downloads the models on a machine that lacks them and warms the stamp and CoreML's cache. */
async function prime(side) {
  return withSide(side, {}, async (helper) => {
    const { version } = helper.events.find((event) => event.type === "ready");
    return {
      protocolVersion: version,
      primeMs: round(await prepareAsr(helper, { download: true })),
    };
  });
}

async function main(options) {
  const sideNamed = (name) => ({
    name,
    binary: resolve(options[name]),
    trace: options.verbose,
  });
  const sides = [...(options.baseline ? [sideNamed("baseline")] : []), sideNamed("candidate")];
  for (const { name, binary } of sides)
    assert(existsSync(binary), `--${name} ${binary} does not exist`);
  const fnpost =
    [options.fnpost, ...sides.map(({ binary }) => join(dirname(binary), "fnpost"))]
      .filter(Boolean)
      .map((path) => resolve(path))
      .find((path) => existsSync(path)) ?? null;
  assert(
    !options.fnpost || fnpost === resolve(options.fnpost),
    `--fnpost ${options.fnpost} does not exist`,
  );

  ensureFixtures();
  mkdirSync(BENCH_HOME, { recursive: true });
  const report = {
    schema: 1,
    command: ["node", fileURLToPath(import.meta.url), ...process.argv.slice(2)].join(" "),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: false,
    failures: [],
    verdictRule: VERDICT_RULE,
    environment: environment(sides, fnpost),
    metrics: {},
  };
  for (const side of sides) {
    note(`priming ${side.name}`);
    Object.assign(report.environment.binaries[side.name], await prime(side));
  }
  for (const name of options.metrics) {
    const runs = options.runs ?? (name === "load-cold" ? DEFAULT_COLD_RUNS : DEFAULT_RUNS);
    note(`${name}: ${runs} runs a side`);
    const startedAt = performance.now();
    let metric;
    try {
      metric = { status: "measured", runs, ...(await RUNNERS[name]({ sides, runs, fnpost })) };
    } catch (error) {
      metric = {
        status: error instanceof Skip ? "skipped" : "failed",
        runs,
        reason: error.message,
      };
    }
    report.metrics[name] = {
      ...metric,
      wallSeconds: round((performance.now() - startedAt) / 1000),
    };
  }
  report.environment.loadAverage.end = loadavg().map(round);
  report.finishedAt = new Date().toISOString();
  report.failures = failures(report);
  report.ok = report.failures.length === 0;

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) {
    mkdirSync(dirname(resolve(options.out)), { recursive: true });
    writeFileSync(options.out, json);
  }
  process.stdout.write(json);
  console.error(formatTable(report));
  for (const failure of report.failures) note(`FAILED ${failure}`);
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stop = (why, code) => async () => {
    note(`${why}: stopping what this run started`);
    await runCleanups();
    process.exit(code);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, stop(signal, 130));
  // A throw from an event handler bypasses every `finally`, and a held key must still come up.
  process.once("uncaughtException", (error) => stop(error.stack ?? String(error), 2)());
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exit(64);
  }
  try {
    await main(options);
  } catch (error) {
    await stop(error.message, 2)();
  }
}

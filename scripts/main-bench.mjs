#!/usr/bin/env node
// Benchmarks the desktop main process and the hub's IPC in an isolated test-mode instance: cold
// start, IPC round trips, the idle footprint, a dictation through the real helper, the same
// session through the scripted helper, and the history store's saves. JSON goes to stdout and
// progress to stderr. Each --root is a built worktree. With several, launches alternate between
// them so every side sees the same machine noise, and each later root is compared with the first:
//
//   node scripts/main-bench.mjs > baseline.json
//   node scripts/main-bench.mjs --root ../voice-base --root . > compare.json
//
// A root runs its own helper unless VOICE_HELPER_PATH names one. Exits 2 when dictation was
// BLOCKED, with every other metric still in the JSON.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { cpus, loadavg, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { runningVoiceProcesses } from "../native/voice-helper/scripts/helper.mjs";
import { fixturesDir } from "./fixtures.mjs";
import { sample, settleMs, watchTree } from "./idle-footprint.mjs";
import { electronTarget } from "./targets.mjs";
import {
  announcedPorts,
  electronDependency,
  landedText,
  Page,
  prepareUserData,
  releaseUserData,
  repoDir,
  smokeEnvironment,
  snapshotStream,
  start,
  stopChildren,
  stopChildrenOnSignal,
  stopGroup,
} from "./voice-app.mjs";

const PRELOAD = "bench-preload.cjs";
const FNPOST = join(repoDir, "native/voice-helper/.build/debug/fnpost");
const FIXTURE = join(fixturesDir, "short.wav");
const TOGGLE_KEY = "rightOption";
const IPC_CALLS = ["getLastTransform", "getSnapshot", "getHistory", "getInsights", "getMeetings"];
const IPC_WARMUP = 20;
const IPC_BATCHES = 10;
const PHASES = ["idle", "ipc", "dictation", "session", "history"];
// Speaks the helper's protocol with no hotkey tap, microphone, speech model or insertion, so a
// session through it needs no unlocked screen and no desktop to itself.
const FAKE_HELPER = join(repoDir, "apps/desktop/src/main/testing/fake-helper.ts");
const SESSION_HOLD_MS = 2000;
const SESSION_TAIL_MS = 1000;
const HISTORY_SAVES = 30;
const SAID =
  "so I think we should move the planning review to Thursday afternoon and invite the whole design team";

// Runs in the main process before main.cjs. Electron has no public hook that early, so the first
// load of its module is where the listeners go; the ready one fires before main() carries on.
// Each mark carries the process's CPU time, which holds still on a busy machine when wall time
// does not, and SIGUSR2 asks for one at any moment. Helpers and model processes inherit
// NODE_OPTIONS, so only the main process acts on it.
const PRELOAD_SOURCE = `if (process.versions.electron && !process.argv.some((arg) => arg.startsWith("--type="))) {
  const mark = (name) => {
    const { user, system } = process.cpuUsage();
    process.stdout.write(\`[bench] \${name} \${Date.now()} \${user + system}\\n\`);
  };
  mark("node");
  process.on("SIGUSR2", () => mark("cpu"));
  const childProcess = require("node:child_process");
  const spawn = childProcess.spawn;
  childProcess.spawn = function (file, ...rest) {
    if (rest[0]?.includes?.("--models-dir")) mark("helper");
    return spawn.call(this, file, ...rest);
  };
  const Module = require("node:module");
  const load = Module._load;
  let hooked = false;
  Module._load = function (request, ...rest) {
    const loaded = load.call(this, request, ...rest);
    if (request === "electron" && loaded?.app && !hooked) {
      hooked = true;
      loaded.app.once("ready", () => mark("ready"));
      loaded.app.on("web-contents-created", (_event, contents) =>
        contents.once(
          "did-finish-load",
          () => contents.getURL().includes("hub.html") && mark("hub"),
        ),
      );
    }
    return loaded;
  };
}
`;

const note = (message) => console.error(`[main-bench] ${message}`);
const round = (value) => Math.round(value * 1000) / 1000;
const sum = (values) => values.reduce((total, value) => total + value, 0);
const settled = (state) => state === "ready" || state === "failed";
const command = (name, ...args) => execFileSync(name, args, { encoding: "utf8" }).trim();
const tap = () => execFileSync(FNPOST, [TOGGLE_KEY], { stdio: "ignore" });
const screenLocked = () =>
  command("ioreg", "-n", "Root", "-d1").includes('"CGSSessionScreenIsLocked"=Yes');

export function stats(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    n: sorted.length,
    median: round(median),
    p95: round(sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)]),
    min: round(sorted[0]),
    max: round(sorted.at(-1)),
    values: values.map(round),
  };
}

// `separated` is the only gap to trust: the two sides' ranges do not overlap. With five runs a
// side, medians that differ inside overlapping ranges are noise.
export function compare(base, candidate) {
  return Object.entries(candidate).flatMap(([metric, after]) => {
    const before = base[metric];
    if (!before) return [];
    return {
      metric,
      base: before.median,
      candidate: after.median,
      deltaPercent:
        before.median === 0 ? null : round(((after.median - before.median) / before.median) * 100),
      separated: after.max < before.min || after.min > before.max,
    };
  });
}

export function sessionTiming(line) {
  return {
    outcome: /outcome=(\w+)/.exec(line)?.[1] ?? null,
    ...Object.fromEntries(
      [...line.matchAll(/(\w+Ms)=(\d+)/g)].map(([, key, value]) => [key, Number(value)]),
    ),
  };
}

function describeBuild(root) {
  const appDir = join(root, "apps/desktop");
  const bundle = join(appDir, "dist-electron/main.cjs");
  assert.ok(existsSync(bundle), `${root} is not built: run pnpm build there`);
  const electron = electronDependency(appDir);
  assert.ok(electron.path, `Electron ${electron.status} in ${root}`);
  const git = (...args) => command("git", "-C", root, ...args);
  return {
    appDir,
    electron: electron.path,
    samples: {},
    ipcBytes: {},
    dictation: { status: "not run", sessions: 0, failed: 0 },
    info: {
      root,
      sha: git("rev-parse", "--short", "HEAD"),
      dirty: git("status", "--porcelain", "--", "apps", "packages", "native") !== "",
      electron: createRequire(join(appDir, "package.json"))("electron/package.json").version,
      mainCjsBytes: statSync(bundle).size,
      builtAt: statSync(bundle).mtime.toISOString(),
    },
  };
}

// RSS drops whenever macOS compresses or swaps an idle process. The footprint counts those pages
// too, so it is the memory number that holds still under memory pressure.
function footprintMb(pid) {
  const output = command("footprint", "-f", "bytes", "--noCategories", String(pid));
  return Number(/phys_footprint: (\d+) B/.exec(output)?.[1]) / 2 ** 20;
}

// A process that left during the sample, like a model process that finished, has none.
function footprintOrZeroMb(pid) {
  try {
    return footprintMb(pid);
  } catch {
    return 0;
  }
}

function record(build, name, value) {
  if (Number.isFinite(value)) (build.samples[name] ??= []).push(value);
}

// The history is rewritten before every launch, so a dictation in one launch never grows the
// list the next one loads.
function seed(userData, count, now) {
  writeHistory(join(userData, "history.json"), count, now);
  writeFileSync(join(userData, PRELOAD), PRELOAD_SOURCE);
}

function writeHistory(file, count, now) {
  const entries = Array.from({ length: count }, (_, index) => {
    const text = `${Array(1 + (index % 4))
      .fill(SAID)
      .join(", and ")}.`;
    return { id: `bench-${index}`, at: now - index * 600_000, raw: text, text, status: "inserted" };
  });
  writeFileSync(file, `${JSON.stringify({ version: 1, retention: "forever", entries })}\n`);
}

const LOADED = `(() => {
  const [navigation] = performance.getEntriesByType("navigation");
  return location.href.includes("hub.html") && navigation?.loadEventEnd > 0
    ? { startedAt: performance.timeOrigin, loadMs: navigation.loadEventEnd }
    : null;
})()`;

// The page reports its own navigation start and load end, so attaching late costs no accuracy.
async function loaded(hub) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const load = await hub.evaluate(LOADED).catch(() => null);
    if (load) return load;
    assert.ok(Date.now() < deadline, "the hub did not load in 30 s");
    await sleep(25);
  }
}

async function launch(build, userData, extraEnv = {}) {
  const output = new EventEmitter();
  const lines = [];
  const capture = join(userData, "capture.wav");
  const spawnedAt = Date.now();
  const child = start(
    build.electron,
    [build.appDir, "--remote-debugging-port=0", "-ApplePersistenceIgnoreState", "YES"],
    {
      cwd: build.appDir,
      env: smokeEnvironment(userData, {
        NODE_OPTIONS: `--require "${join(userData, PRELOAD)}"`,
        VOICE_HELPER_TEST_AUDIO: capture,
        ...extraEnv,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  createInterface({ input: child.stdout }).on("line", (text) => {
    lines.push({ at: Date.now() - spawnedAt, text });
    output.emit("line");
  });
  async function logged(pattern, { from = 0, timeoutMs = 30_000 } = {}) {
    const signal = AbortSignal.timeout(timeoutMs);
    for (;;) {
      const line = lines.slice(from).find(({ text }) => pattern.test(text));
      if (line) return line;
      await once(output, "line", { signal }).catch(() => {
        throw new Error(`no ${pattern} line after ${timeoutMs} ms`);
      });
    }
  }

  const { DevTools: port } = await announcedPorts(child, ["DevTools"]);
  const hub = await Page.connect(port, "hub.html");
  const hubLoad = await loaded(hub);
  const snapshots = await snapshotStream(hub);
  const { models, permissions } = await snapshots.waitFor(
    (s) => settled(s.models.asr.state) && settled(s.models.cleanup.state),
    { timeoutMs: 180_000, label: "the models to settle" },
  );
  const modelsReadyMs = Date.now() - spawnedAt;
  assert.ok(
    models.asr.state === "ready" && models.cleanup.state === "ready",
    `models failed to load: ${JSON.stringify(models)}`,
  );
  // A window covered by another app never paints, so this stays null there.
  const paint = await hub.evaluate(
    `performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null`,
  );
  const marked = async (name) => {
    const [, , at, cpuUs] = (await logged(new RegExp(`^\\[bench\\] ${name} `))).text.split(" ");
    return { ms: Number(at) - spawnedAt, cpuMs: Number(cpuUs) / 1000 };
  };
  const [node, ready, hubMark] = [await marked("node"), await marked("ready"), await marked("hub")];
  const helperSpawn = await marked("helper");
  return {
    child,
    hub,
    snapshots,
    lines,
    logged,
    capture,
    userData,
    permissions,
    timeline: {
      nodeStartMs: node.ms,
      mainEnteredMs: (await logged(/^\[voice\] userData /)).at,
      readyMs: ready.ms,
      readyCpuMs: ready.cpuMs,
      hubLoadedCpuMs: hubMark.cpuMs,
      hubNavigationMs: hubLoad.startedAt - spawnedAt,
      hubLoadedMs: hubLoad.startedAt + hubLoad.loadMs - spawnedAt,
      hubPaintedMs: paint === null ? null : hubLoad.startedAt + paint - spawnedAt,
      helperSpawnedMs: helperSpawn.ms,
      helperSpawnedCpuMs: helperSpawn.cpuMs,
      helperReadyMs: (await logged(/^\[voice\] helper ready /)).at,
      modelsReadyMs,
    },
  };
}

// The five segments add up to hubLoadedMs. main() runs from ready to its end without yielding and
// loads the hub last, so the hub's navigation start closes main's own setup.
function recordColdStart(build, t) {
  record(build, "cold.electronBootMs", t.nodeStartMs);
  record(build, "cold.mainEvalMs", t.mainEnteredMs - t.nodeStartMs);
  record(build, "cold.chromiumReadyMs", t.readyMs - t.mainEnteredMs);
  record(build, "cold.mainSetupMs", t.hubNavigationMs - t.readyMs);
  record(build, "cold.hubLoadMs", t.hubLoadedMs - t.hubNavigationMs);
  record(build, "cold.hubLoadedMs", t.hubLoadedMs);
  record(build, "cold.mainCpuToReadyMs", t.readyCpuMs);
  record(build, "cold.mainCpuToHubLoadedMs", t.hubLoadedCpuMs);
  record(build, "cold.hubPaintedMs", t.hubPaintedMs);
  record(build, "cold.helperSpawnedAfterReadyMs", t.helperSpawnedMs - t.readyMs);
  record(build, "cold.mainCpuReadyToHelperSpawnMs", t.helperSpawnedCpuMs - t.readyCpuMs);
  record(build, "cold.helperBootMs", t.helperReadyMs - t.helperSpawnedMs);
  record(build, "cold.helperReadyMs", t.helperReadyMs);
  record(build, "cold.modelsReadyMs", t.modelsReadyMs);
}

async function measureIdle(build, app, idleMs) {
  note(`settling ${settleMs / 1000} s, then sampling ${idleMs / 1000} s of idle`);
  await sleep(settleMs);
  const rows = await sample(app.child.pid, idleMs);
  const mainRow = rows.find((row) => row.pid === app.child.pid);
  assert.ok(mainRow && mainRow.samples > 1, "the main process was not sampled while idle");
  record(build, "idle.mainCpuPercent", mainRow.cpuPercent);
  record(build, "idle.mainRssMb", mainRow.rssMb);
  record(build, "idle.mainFootprintMb", footprintMb(app.child.pid));
  record(build, "idle.totalCpuPercent", sum(rows.map((row) => row.cpuPercent)));
  record(build, "idle.totalRssMb", sum(rows.map((row) => row.rssMb)));
  record(build, "idle.totalFootprintMb", sum(rows.map((row) => footprintOrZeroMb(row.pid))));
}

// The renderer clock ticks in 0.1 ms steps, so a cheap call is timed as the mean of a batch, and
// taking the median batch keeps one scheduler stall out of the result.
const IPC_LOOP = (name, batchSize) => `(async () => {
  const call = () => window.voice.${name}();
  for (let i = 0; i < ${IPC_WARMUP}; i += 1) await call();
  const callMs = [];
  const batchMs = [];
  for (let batch = 0; batch < ${IPC_BATCHES}; batch += 1) {
    const from = performance.now();
    for (let i = 0; i < ${batchSize}; i += 1) {
      const at = performance.now();
      await call();
      callMs.push(performance.now() - at);
    }
    batchMs.push((performance.now() - from) / ${batchSize});
  }
  const result = await call();
  return {
    callMs,
    batchMs,
    bytes: JSON.stringify(result ?? null).length,
    entries: result?.entries?.length ?? null,
  };
})()`;

async function measureIpc(build, app, { iterations, history }) {
  for (const name of IPC_CALLS) {
    const { callMs, batchMs, bytes, entries } = await app.hub.evaluate(
      IPC_LOOP(name, Math.ceil(iterations / IPC_BATCHES)),
    );
    if (name === "getHistory") {
      assert.equal(entries, history, "getHistory did not return the seeded history");
    }
    record(build, `ipc.${name}.ms`, stats(batchMs).median);
    record(build, `ipc.${name}.p95Ms`, stats(callMs).p95);
    build.ipcBytes[name] = bytes;
  }
}

function dictationBlocker(app) {
  if (!existsSync(FNPOST))
    return "fnpost is not built: swift build --package-path native/voice-helper";
  if (app.permissions.accessibility !== "granted")
    return "Accessibility is not granted to the app that launched this script";
  if (screenLocked()) return "the screen is locked, so no insertion target can take focus";
  const others = runningVoiceProcesses().filter((line) => !line.includes(app.userData));
  if (others.length === 0) return null;
  const pids = others.map((line) => line.split(" ")[0]).join(", ");
  return `another Voice would hear the synthetic hotkey (pid ${pids}); wait for it to stop`;
}

// A session starts and ends on a real synthetic key tap, which every Voice on this desktop hears.
async function dictate(app, target) {
  copyFileSync(FIXTURE, app.capture);
  app.snapshots.skipToEnd();
  const from = app.lines.length;
  const stopWatching = watchTree(app.child.pid);
  const pressedAt = performance.now();
  let rows;
  let line;
  try {
    tap();
    await app.snapshots.waitFor((s) => s.session.kind === "listening", {
      timeoutMs: 5000,
      label: "the session to start listening",
    });
    await app.logged(/helper info: test\.audioFile ended$/, { from, timeoutMs: 60_000 });
    tap();
    line = await app.logged(/^\[voice\] session \w+ outcome=/, { from, timeoutMs: 90_000 });
  } finally {
    rows = stopWatching();
    rmSync(app.capture, { force: true });
  }
  const wallMs = performance.now() - pressedAt;
  const timing = sessionTiming(line.text);
  const latest = await app.hub.evaluate("window.voice.getHistory().then((h) => h.entries[0])");
  const { landedMs } = await landedText(target.read, latest.text);
  await app.snapshots.waitFor((s) => s.session.kind === "idle", {
    timeoutMs: 15_000,
    label: "the session to end",
  });
  const mainRow = rows.find((row) => row.pid === app.child.pid);
  return {
    inserted: timing.outcome === "inserted" && !latest.id.startsWith("bench-") && landedMs !== null,
    timing,
    wallMs,
    mainCpuMs: mainRow.cpuS * 1000,
    mainRssPeakMb: mainRow.rssPeakMb,
    mainFootprintMb: footprintMb(app.child.pid),
    treeCpuMs: sum(rows.map((row) => row.cpuS)) * 1000,
  };
}

// The first session of a launch warms the cleanup model and the JIT, so only later ones count.
async function measureDictation(build, app, sessions) {
  const blocked = (reason) => {
    if (reason === null) return false;
    note(`dictation BLOCKED: ${reason}`);
    build.dictation = { ...build.dictation, status: "BLOCKED", reason };
    return true;
  };
  if (blocked(dictationBlocker(app))) return;
  await app.hub.evaluate(
    `window.voice.updateSettings({ toggleHotkey: ${JSON.stringify(TOGGLE_KEY)} })`,
  );
  const target = await electronTarget(app.userData);
  try {
    for (let index = 0; index < sessions; index += 1) {
      const unfocused = await target.open().then(
        () => null,
        (error) => `the insertion target could not take focus (${error.message})`,
      );
      if (blocked(dictationBlocker(app) ?? unfocused)) return;
      const session = await dictate(app, target);
      note(`session ${index + 1}: ${JSON.stringify(session.timing)}`);
      if (index === 0 && sessions > 1) continue;
      build.dictation.sessions += 1;
      if (!session.inserted) {
        build.dictation.failed += 1;
        continue;
      }
      if (build.dictation.status === "not run") build.dictation.status = "ok";
      record(build, "dictation.wallMs", session.wallMs);
      record(build, "dictation.mainCpuMs", session.mainCpuMs);
      record(build, "dictation.mainRssPeakMb", session.mainRssPeakMb);
      record(build, "dictation.mainFootprintMb", session.mainFootprintMb);
      record(build, "dictation.treeCpuMs", session.treeCpuMs);
      for (const [key, value] of Object.entries(session.timing)) {
        record(build, `dictation.session.${key}`, value);
      }
    }
  } finally {
    await target.close();
  }
}

// ps reports CPU time in hundredths of a second, too coarse for one session.
async function mainCpuMs(app) {
  const from = app.lines.length;
  // A signal to a pid the system has handed to another process would end that process.
  assert.equal(app.child.exitCode, null, "Voice exited during the session");
  process.kill(app.child.pid, "SIGUSR2");
  const [, , , cpuUs] = (await app.logged(/^\[bench\] cpu /, { from })).text.split(" ");
  return Number(cpuUs) / 1000;
}

// The main process's own share of a dictation: the helper's events, the store and both windows,
// the history saves, and the hand-off to cleanup. The scripted helper holds the key for a fixed
// time, so every session carries the same number of level events.
async function measureSessions(build, userData, { sessions }) {
  const control = join(tmpdir(), `voice-bench-${process.pid}.sock`);
  const app = await launch(build, userData, {
    VOICE_HELPER_PATH: FAKE_HELPER,
    VOICE_FAKE_HELPER: JSON.stringify({ control, transcript: SAID }),
  });
  const helper = connect(control);
  try {
    await once(helper, "connect");
    for (let index = 0; index <= sessions; index += 1) {
      app.snapshots.skipToEnd();
      const from = app.lines.length;
      const cpuBefore = await mainCpuMs(app);
      helper.write("down\n");
      await app.snapshots.waitFor((s) => s.session.kind === "listening", {
        timeoutMs: 5000,
        label: "the scripted session to start listening",
      });
      await sleep(SESSION_HOLD_MS);
      helper.write("up\n");
      const line = await app.logged(/^\[voice\] session \w+ outcome=/, { from, timeoutMs: 60_000 });
      await sleep(SESSION_TAIL_MS);
      const cpuMs = (await mainCpuMs(app)) - cpuBefore;
      const timing = sessionTiming(line.text);
      const latest = await app.hub.evaluate("window.voice.getHistory().then((h) => h.entries[0])");
      assert.ok(
        timing.outcome === "inserted" && latest.raw === SAID,
        `the scripted session did not insert its transcript: ${line.text}`,
      );
      if (index === 0) continue;
      record(build, "session.mainCpuMs", cpuMs);
      record(build, "session.cleanupMs", timing.cleanupMs);
    }
  } finally {
    helper.destroy();
    app.hub.close();
    await stopGroup(app.child);
    rmSync(control, { force: true });
  }
}

// One dictation saves the history twice: the transcript when it arrives, then how it ended. The
// store runs here in Node, from each root's source, with the event loop's longest stall as the
// time a key press could have waited behind a save.
async function measureHistory(build, { history, now }) {
  const { createHistory } = await import(join(build.info.root, "apps/desktop/src/main/history.ts"));
  const dir = mkdtempSync(join(tmpdir(), "voice-bench-history-"));
  try {
    writeHistory(join(dir, "history.json"), history, now);
    const store = createHistory({ file: join(dir, "history.json"), log: note, onChange: () => {} });
    await store.loaded();
    assert.equal(store.entries().length, history, "the history store did not load the seed");
    const save = async (id) => {
      store.remember({ id, raw: SAID, text: SAID, status: "pending" }, Date.now());
      await store.settled();
      store.settle(id, true);
      await store.settled();
    };
    for (let index = 0; index < 5; index += 1) await save(`warm-${index}`);
    const stalls = [];
    let tick = performance.now();
    const timer = setInterval(() => {
      stalls.push(performance.now() - tick - 1);
      tick = performance.now();
    }, 1);
    const cpu = process.cpuUsage();
    const from = performance.now();
    for (let index = 0; index < HISTORY_SAVES; index += 1) await save(`save-${index}`);
    const wallMs = performance.now() - from;
    const { user, system } = process.cpuUsage(cpu);
    clearInterval(timer);
    assert.equal(store.state().saveFailed, false, "a history save failed");
    assert.equal(store.entries().length, history + 5 + HISTORY_SAVES, "a dictation was not kept");
    record(build, "history.dictationCpuMs", (user + system) / 1000 / HISTORY_SAVES);
    record(build, "history.dictationWallMs", wallMs / HISTORY_SAVES);
    record(build, "history.longestStallMs", Math.max(...stalls));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function run(build, userData, options, { warmup = false } = {}) {
  note(`${warmup ? "warming" : "measuring"} ${build.info.sha} in ${build.info.root}`);
  seed(userData, options.history, options.now);
  const app = await launch(build, userData);
  try {
    note(`hub loaded in ${Math.round(app.timeline.hubLoadedMs)} ms`);
    if (warmup) {
      build.warmup = app.timeline;
      return;
    }
    recordColdStart(build, app.timeline);
    if (options.phases.includes("idle")) await measureIdle(build, app, options.idleMs);
    if (options.phases.includes("ipc")) await measureIpc(build, app, options);
    if (options.phases.includes("dictation")) await measureDictation(build, app, options.sessions);
  } finally {
    app.hub.close();
    await stopGroup(app.child);
  }
  if (options.phases.includes("session")) {
    seed(userData, options.history, options.now);
    await measureSessions(build, userData, options);
  }
  if (options.phases.includes("history")) await measureHistory(build, options);
}

async function main() {
  const { values } = parseArgs({
    options: {
      root: { type: "string", multiple: true },
      runs: { type: "string", default: "5" },
      history: { type: "string", default: "2000" },
      iterations: { type: "string", default: "200" },
      "idle-ms": { type: "string", default: "20000" },
      sessions: { type: "string", default: "2" },
      skip: { type: "string", multiple: true, default: [] },
    },
  });
  for (const phase of values.skip) {
    assert.ok(PHASES.includes(phase), `--skip takes ${PHASES.join(", ")}`);
  }
  const options = {
    runs: Number(values.runs),
    history: Number(values.history),
    iterations: Number(values.iterations),
    idleMs: Number(values["idle-ms"]),
    sessions: Number(values.sessions),
    phases: PHASES.filter((phase) => !values.skip.includes(phase)),
    now: Date.now(),
  };
  const builds = (values.root ?? [repoDir]).map((root) => describeBuild(resolve(root)));
  const environment = {
    machine: command("sysctl", "-n", "hw.model"),
    cpu: command("sysctl", "-n", "machdep.cpu.brand_string"),
    cores: cpus().length,
    ramGb: Math.round(totalmem() / 2 ** 30),
    macos: command("sw_vers", "-productVersion"),
    node: process.version,
    where: process.env.CI ? "ci" : "local",
    startedAt: new Date(options.now).toISOString(),
    loadAverageStart: round(loadavg()[0]),
    screenLocked: screenLocked(),
  };

  const userData = await prepareUserData("voice-main-bench");
  /** @type {unknown} */
  let failure = null;
  try {
    for (const build of builds) await run(build, userData, options, { warmup: true });
    for (let index = 0; index < options.runs; index += 1) {
      for (const build of index % 2 ? builds.toReversed() : builds) {
        await run(build, userData, options);
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    await stopChildren();
    await releaseUserData(userData, { remove: true });
  }

  const results = builds.map((build) => ({
    ...build.info,
    metrics: Object.fromEntries(
      Object.entries(build.samples).map(([name, samples]) => [name, stats(samples)]),
    ),
    ipcBytes: build.ipcBytes,
    dictation: build.dictation,
    warmup: build.warmup,
  }));
  const [base, ...candidates] = results;
  assert.ok(base, "--root names no build");
  const report = {
    environment: { ...environment, loadAverageEnd: round(loadavg()[0]) },
    ...(failure ? { error: String(failure) } : {}),
    options,
    builds: results,
    comparisons: candidates.map((candidate) => ({
      base: base.root,
      candidate: candidate.root,
      metrics: compare(base.metrics, candidate.metrics),
    })),
  };
  console.log(
    JSON.stringify(report, null, 2).replace(/\[[\d\s.,-]+\]/g, (list) => list.replace(/\s+/g, " ")),
  );
  if (failure) throw failure;
  if (builds.some((build) => build.dictation.status === "BLOCKED")) process.exitCode = 2;
}

if (import.meta.main) {
  stopChildrenOnSignal();
  await main();
}

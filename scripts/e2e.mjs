#!/usr/bin/env node
// End-to-end proof of shortcut -> capture -> ASR -> cleanup -> insertion through the built app.
// No microphone and no human: the helper streams a fixture WAV per capture and fnpost presses
// the real hotkey through the HID event tap. Needs Accessibility for the app that launches
// this script, and briefly brings TextEdit to the front.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { downloadS1Mini, S1_MINI_FILE } from "../packages/cleanup/src/download.ts";

const repoDir = fileURLToPath(new URL("..", import.meta.url));
const desktopDir = join(repoDir, "apps/desktop");
const helperDir = join(repoDir, "native/voice-helper");
const fixturesDir = join(repoDir, "test-fixtures/audio");
const spike = {
  parakeet: "/tmp/voice-spike-swift/models/parakeet-tdt-0.6b-v3",
  s1Mini: "/tmp/voice-spike-s1/s1-mini-q4_k_m.gguf",
};
const ports = { voice: 9345, target: 9346 };
const electronPath = createRequire(join(desktopDir, "package.json"))("electron");

const hasSpeech = (text) => text.includes("Anna") && text.includes("Thursday");

// One row per case. `end` is how the hold ends: after the fixture has streamed, as soon as the
// pill listens, or with Escape while listening. `outcome` null means the session was cancelled
// and the pill went straight back to idle.
const cases = [
  {
    name: "a-short-cleanup",
    wav: "short.wav",
    settings: { cleanup: { enabled: true, structure: "prose" } },
    end: "audio",
    target: "textedit",
    outcome: "inserted",
    check: ({ text }) => assert(hasSpeech(text), `document lacks Anna/Thursday: ${show(text)}`),
  },
  {
    name: "b-list-structure",
    wav: "list.wav",
    settings: { cleanup: { enabled: true, structure: "lists" } },
    end: "audio",
    target: "textedit",
    outcome: "inserted",
    check: ({ text }) =>
      assert(/^\s*[-*•]\s*milk\b/im.test(text), `document has no "- Milk" line: ${show(text)}`),
  },
  {
    name: "c-silence",
    wav: "silence.wav",
    settings: { cleanup: { enabled: true, structure: "prose" } },
    end: "audio",
    target: "textedit",
    outcome: "empty",
    check: ({ text, before }) => assert(text === before, `document changed: ${show(text)}`),
  },
  {
    name: "d-escape-cancels",
    wav: "short.wav",
    settings: { cleanup: { enabled: true, structure: "prose" } },
    end: "escape",
    target: "textedit",
    outcome: null,
    check: ({ text, before }) => assert(text === before, `document changed: ${show(text)}`),
  },
  {
    name: "e-too-short",
    wav: "short.wav",
    settings: { cleanup: { enabled: true, structure: "prose" } },
    end: "immediate",
    target: "textedit",
    outcome: "tooShort",
    check: ({ text, before }) => assert(text === before, `document changed: ${show(text)}`),
  },
  {
    name: "f-cleanup-off",
    wav: "short.wav",
    settings: { cleanup: { enabled: false } },
    end: "audio",
    target: "textedit",
    outcome: "inserted",
    check: ({ text, snapshot, timing }) => {
      const { raw, text: cleaned } = snapshot.last;
      assert(text === raw, `document ${show(text)} != raw transcript ${show(raw)}`);
      assert(cleaned === raw, `cleanup ran with cleanup off: ${show(cleaned)}`);
      assert(hasSpeech(raw), `raw transcript lacks Anna/Thursday: ${show(raw)}`);
      assert(timing.cleanupMs === undefined, `timing has cleanupMs=${timing.cleanupMs}`);
    },
  },
  {
    name: "g-electron-textarea",
    wav: "short.wav",
    settings: { cleanup: { enabled: true, structure: "prose" } },
    end: "audio",
    target: "electron",
    outcome: "inserted",
    check: ({ text }) => assert(hasSpeech(text), `textarea lacks Anna/Thursday: ${show(text)}`),
  },
];

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

const show = (value) => JSON.stringify(value);
const note = (message) => console.error(`[e2e] ${message}`);

function run(command, args, options = {}) {
  note(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: repoDir, stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}

function osascript(script) {
  return execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();
}

function fnpost(...args) {
  execFileSync(join(helperDir, ".build/debug/fnpost"), args, { stdio: "ignore" });
}

// An ordered log of observations with one cursor, so a script reads the run as a conversation
// and a stale match from an earlier case can never satisfy a later wait.
class Stream {
  items = [];
  #cursor = 0;
  #waiters = [];

  push(item) {
    this.items.push(item);
    for (const waiter of this.#waiters.splice(0)) waiter();
  }

  skipToEnd() {
    this.#cursor = this.items.length;
  }

  waitFor(predicate, { timeoutMs, label }) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out after ${timeoutMs} ms waiting for ${label}`)),
        timeoutMs,
      );
      const check = () => {
        for (let i = this.#cursor; i < this.items.length; i += 1) {
          if (!predicate(this.items[i])) continue;
          this.#cursor = i + 1;
          clearTimeout(timer);
          resolve(this.items[i]);
          return;
        }
        this.#waiters.push(check);
      };
      check();
    });
  }
}

class Page {
  #nextId = 1;
  #pending = new Map();
  #bindings = new Map();

  static async connect(port, urlPart, { timeoutMs = 30_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        const target = targets.find((t) => t.type === "page" && t.url.includes(urlPart));
        if (target) return await Page.open(target.webSocketDebuggerUrl);
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`no ${urlPart} page on CDP port ${port} after ${timeoutMs} ms`);
  }

  static open(url) {
    const ws = new WebSocket(url);
    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(new Page(ws)), { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
  }

  constructor(ws) {
    this.ws = ws;
    ws.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.id !== undefined) {
        const settle = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) settle.reject(new Error(message.error.message));
        else settle.resolve(message.result);
      } else if (message.method === "Runtime.bindingCalled") {
        this.#bindings.get(message.params.name)?.(message.params.payload);
      }
    });
  }

  call(method, params = {}) {
    const id = this.#nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text} ${expression}`);
    return result.value;
  }

  async bind(name, listener) {
    await this.call("Runtime.enable");
    await this.call("Runtime.addBinding", { name });
    this.#bindings.set(name, listener);
  }

  close() {
    this.ws.close();
  }
}

// Every process this script starts leads its own group, so shutdown can signal the tools a
// child spawned too and a terminal Ctrl+C reaches only this script.
const children = new Set();

function start(command, args, options) {
  const child = spawn(command, args, { detached: true, ...options });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

async function stopChildren() {
  const exits = [...children].map((child) => new Promise((resolve) => child.once("exit", resolve)));
  for (const child of children) signalGroup(child, "SIGTERM");
  const force = setTimeout(() => {
    for (const child of children) signalGroup(child, "SIGKILL");
  }, 3000);
  await Promise.all(exits);
  clearTimeout(force);
}

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group already exited.
  }
}

function wavDurationMs(buffer) {
  const tag = (at) => buffer.toString("ascii", at, at + 4);
  assert(tag(0) === "RIFF" && tag(8) === "WAVE", "fixture is not a RIFF WAVE file");
  let byteRate;
  let dataBytes;
  for (let at = 12; at + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(at + 4);
    if (tag(at) === "fmt ") byteRate = buffer.readUInt32LE(at + 16);
    if (tag(at) === "data") dataBytes = size;
    at += 8 + size + (size % 2);
  }
  assert(byteRate && dataBytes !== undefined, "fixture lacks a fmt or data chunk");
  return (dataBytes / byteRate) * 1000;
}

// A stable path: CoreML caches compiled models by path, and a fresh path costs ~40 s per run.
async function prepareUserData() {
  const userData = join(tmpdir(), "voice-e2e");
  rmSync(userData, { recursive: true, force: true });
  const models = join(userData, "models");
  mkdirSync(models, { recursive: true });
  assert(existsSync(spike.parakeet), `Parakeet is missing at ${spike.parakeet}`);
  symlinkSync(spike.parakeet, join(models, "parakeet-tdt-0.6b-v3"));
  if (existsSync(spike.s1Mini)) {
    symlinkSync(spike.s1Mini, join(models, S1_MINI_FILE));
  } else {
    note(`downloading S1-mini into ${models}`);
    await downloadS1Mini({ dir: models });
  }
  return userData;
}

function launchVoice(userData, audioPath) {
  const env = {
    ...process.env,
    VOICE_HELPER_TEST: "1",
    VOICE_USER_DATA_DIR: userData,
    VOICE_HELPER_TEST_AUDIO: audioPath,
  };
  // Set when this script itself runs under Electron, for example inside an Electron-based IDE.
  delete env.ELECTRON_RUN_AS_NODE;
  const child = start(electronPath, [".", `--remote-debugging-port=${ports.voice}`], {
    cwd: desktopDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = new Stream();
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (line.startsWith("[voice]")) console.error(line);
    logs.push(line);
  });
  createInterface({ input: child.stderr }).on("line", (line) => {
    if (process.env.VOICE_E2E_VERBOSE) console.error(`[voice stderr] ${line}`);
  });
  return { child, logs };
}

const frontmostPid = () =>
  Number(
    osascript(
      'tell application "System Events" to unix id of first process whose frontmost is true',
    ),
  );

async function activate(pid, name) {
  osascript(
    `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
  );
  const deadline = Date.now() + 5000;
  while (frontmostPid() !== pid) {
    assert(Date.now() < deadline, `${name} (pid ${pid}) did not become frontmost`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Each case gets its own empty file. An untitled document would be renamed from its content and
// could not be addressed again, and launching TextEdit through a file opens nothing else. Only
// documents this script opened are touched: TextEdit restores autosaved untitled documents from
// earlier crashes, and quitting over one of those raises a save sheet that blocks every later
// AppleEvent.
function textEditTarget(userData) {
  const wasRunning = osascript('application "TextEdit" is running') === "true";
  const dir = join(userData, "textedit");
  mkdirSync(dir);
  const documents = [];
  const current = () => `document ${show(documents.at(-1))}`;
  return {
    name: "TextEdit",
    async open(caseName) {
      const file = join(dir, `${caseName}.txt`);
      writeFileSync(file, "");
      osascript(`tell application "TextEdit" to open POSIX file ${show(file)}`);
      documents.push(`${caseName}.txt`);
      const pid = osascript('tell application "System Events" to unix id of process "TextEdit"');
      await activate(Number(pid), "TextEdit");
    },
    read: () => osascript(`tell application "TextEdit" to get text of ${current()}`),
    close() {
      for (const name of documents.splice(0)) {
        osascript(`tell application "TextEdit" to close document ${show(name)} saving no`);
      }
      const remaining = Number(osascript('tell application "TextEdit" to count documents'));
      if (!wasRunning && remaining === 0) osascript('tell application "TextEdit" to quit');
    },
  };
}

async function electronTarget(userData) {
  const env = { ...process.env, VOICE_E2E_TARGET_USER_DATA: join(userData, "target") };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = start(
    electronPath,
    [join(repoDir, "scripts/e2e-target/main.cjs"), `--remote-debugging-port=${ports.target}`],
    { env, stdio: ["ignore", "ignore", "ignore"] },
  );
  const page = await Page.connect(ports.target, "index.html");
  const field = 'document.getElementById("field")';
  return {
    name: "Electron target",
    async open() {
      await activate(child.pid, "Electron target");
      const focused = await page.evaluate(
        `${field}.value = ""; ${field}.focus(); document.hasFocus() && document.activeElement.id`,
      );
      assert(focused === "field", `textarea is not focused (activeElement ${show(focused)})`);
    },
    read: () => page.evaluate(`${field}.value`),
    close() {
      page.close();
    },
  };
}

function parseTiming(line) {
  const [, id, outcome, rest] = /\[voice\] session (\w+) outcome=(\w+)(.*)$/.exec(line);
  const timing = { id, outcome };
  for (const [, key, value] of rest.matchAll(/(\w+)=(\d+)/g)) timing[key] = Number(value);
  return timing;
}

async function runCase(c, { snapshots, logs, hub, audioPath, targets }) {
  const target = targets[c.target];
  const wav = readFileSync(join(fixturesDir, c.wav));
  copyFileSync(join(fixturesDir, c.wav), audioPath);
  const wavMs = wavDurationMs(wav);

  await hub.evaluate(`window.voice.updateSettings(${show(c.settings)})`);
  const applied = await hub.evaluate(
    "window.voice.getSnapshot().then((s) => JSON.stringify(s.settings.cleanup))",
  );
  for (const [key, value] of Object.entries(c.settings.cleanup)) {
    assert(
      JSON.parse(applied)[key] === value,
      `settings.cleanup.${key} is not ${value}: ${applied}`,
    );
  }

  await target.open(c.name);
  const before = await target.read();
  snapshots.skipToEnd();
  logs.skipToEnd();

  fnpost("fn", "down");
  const pressedAt = performance.now();
  await snapshots.waitFor((s) => s.session.kind === "listening", {
    timeoutMs: 5000,
    label: "pill listening after fn down",
  });
  if (c.end === "audio") {
    await logs.waitFor((line) => line.endsWith("helper info: test.audioFile ended"), {
      timeoutMs: wavMs + 5000,
      label: `${c.wav} (${Math.round(wavMs)} ms) to finish streaming`,
    });
  }
  if (c.end === "escape") fnpost("escape");
  else fnpost("fn", "up");
  const heldMs = Math.round(performance.now() - pressedAt);

  let snapshot;
  let timing = null;
  if (c.end === "escape") {
    snapshot = await snapshots.waitFor((s) => s.session.kind === "idle", {
      timeoutMs: 5000,
      label: "pill idle after Escape",
    });
    fnpost("fn", "up");
  } else {
    snapshot = await snapshots.waitFor((s) => s.session.kind === "done", {
      timeoutMs: 90_000,
      label: "pill done",
    });
    timing = parseTiming(
      await logs.waitFor((line) => /\[voice\] session \w+ outcome=/.test(line), {
        timeoutMs: 5000,
        label: "session timing line",
      }),
    );
  }
  const text = await target.read();
  const outcome = snapshot.session.outcome ?? null;
  try {
    assert(
      (outcome?.kind ?? null) === c.outcome,
      `outcome ${show(outcome)} != ${c.outcome} (held ${heldMs} ms, document ${show(text)})`,
    );
    c.check({ text, before, snapshot, timing });
  } finally {
    console.log(
      JSON.stringify({
        case: c.name,
        target: target.name,
        outcome,
        text,
        heldMs,
        timing: timing && {
          startMs: timing.startMs,
          audioMs: timing.audioMs,
          asrMs: timing.asrMs,
          cleanupMs: timing.cleanupMs,
          insertMs: timing.insertMs,
          releaseToInsertMs: timing.releaseToInsertMs,
        },
      }),
    );
  }
}

async function main() {
  run("swift", ["build", "--package-path", helperDir]);
  run("node", [join(repoDir, "scripts/fixtures.mjs")]);
  run("pnpm", ["build"]);

  const userData = await prepareUserData();
  const audioPath = join(userData, "capture.wav");
  const targets = {};
  const pages = [];
  try {
    const { logs } = launchVoice(userData, audioPath);
    const pill = await Page.connect(ports.voice, "pill.html");
    const hub = await Page.connect(ports.voice, "hub.html");
    pages.push(pill, hub);
    const snapshots = new Stream();
    await pill.bind("__voiceE2E", (payload) => snapshots.push(JSON.parse(payload)));
    await pill.evaluate(`
      window.voice.onSnapshot((s) => __voiceE2E(JSON.stringify(s)));
      window.voice.getSnapshot().then((s) => __voiceE2E(JSON.stringify(s)));
      true`);

    const first = await snapshots.waitFor((s) => s.permissions.accessibility !== "notDetermined", {
      timeoutMs: 15_000,
      label: "permission report",
    });
    assert(
      first.permissions.accessibility === "granted",
      "Accessibility is not granted to the app running this script; the hotkey tap cannot install",
    );
    await logs.waitFor((line) => line.endsWith("helper info: hotkey tap installed"), {
      timeoutMs: 15_000,
      label: "hotkey tap installed",
    });
    await snapshots.waitFor(
      (s) => s.models.asr.state === "ready" && s.models.cleanup.state === "ready",
      { timeoutMs: 180_000, label: "speech and cleanup models ready" },
    );

    targets.textedit = textEditTarget(userData);
    targets.electron = await electronTarget(userData);
    for (const c of cases) await runCase(c, { snapshots, logs, hub, audioPath, targets });
    note(`all ${cases.length} cases passed`);
  } finally {
    await teardown();
  }

  // Each step runs even if an earlier one fails, and none may hide the error that got us here.
  async function teardown() {
    const steps = [
      ...pages.map((page) => () => page.close()),
      ...Object.values(targets).map((target) => () => target.close()),
      stopChildren,
      () => rmSync(userData, { recursive: true, force: true }),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        note(`teardown: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void stopChildren().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

await main();

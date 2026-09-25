#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  assert,
  electronPath,
  launchVoice,
  Page,
  prepareUserData,
  repoDir,
  start,
  stopChildren,
  stopChildrenOnSignal,
  Stream,
} from "./voice-app.mjs";

const helperDir = join(repoDir, "native/voice-helper");
const fixturesDir = join(repoDir, "test-fixtures/audio");
const ports = { voice: 9345, target: 9346 };

const hasSpeech = (text) => text.includes("Anna") && text.includes("Thursday");

const cases = [
  {
    name: "a-short-cleanup",
    wav: "short.wav",
    settings: { cleanup: { enabled: true, structure: "prose" } },
    end: "audio",
    target: "textedit",
    outcome: "inserted",
    check: ({ text }) => {
      assert(hasSpeech(text), `document lacks Anna/Thursday: ${show(text)}`);
      assert(/^\p{Lu}/u.test(text), `document does not start with a capital: ${show(text)}`);
    },
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

  const userData = await prepareUserData("voice-e2e");
  const audioPath = join(userData, "capture.wav");
  const targets = {};
  const pages = [];
  try {
    const { logs } = launchVoice(userData, {
      port: ports.voice,
      env: { VOICE_HELPER_TEST_AUDIO: audioPath },
    });
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

stopChildrenOnSignal();
await main();

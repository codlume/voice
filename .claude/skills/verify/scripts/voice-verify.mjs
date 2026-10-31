#!/usr/bin/env node
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  CONTENDING_VOICE_MESSAGE,
  runningVoiceProcesses,
} from "../../../../native/voice-helper/scripts/helper.mjs";
import { fixturesDir } from "../../../../scripts/fixtures.mjs";
import {
  clipboardKept,
  electronTarget,
  restoreClipboard,
  saveClipboard,
  textEditTarget,
} from "../../../../scripts/targets.mjs";
import { clickExpression, visible } from "./click-expression.mjs";
import { parseDictateFlags } from "./dictate-flags.mjs";
import { keyEvents } from "./key-events.mjs";
import {
  expectedLanding,
  freshLast,
  optionShortcutTransform,
  parseTransformFlags,
  pillSummary,
  resolveOutcome,
  shouldEscape,
  TRANSFORM_PARAGRAPH,
  transformLogLine,
} from "./transforms.mjs";
import { scenarioNamed, scenarioPrerequisites, scenarioSettings } from "./scenarios.mjs";
import {
  claimScratch,
  electronDependency,
  electronPath,
  evaluateInMain,
  landedText,
  modelFiles,
  optionalModelFiles,
  Page,
  prepareUserData,
  processIdentity,
  releaseUserData,
  repoDir,
  sameProcess,
  scratchPath,
  signalGroup,
  smokeEnvironment,
  snapshotStream,
  start,
  stopChildren,
  launchVoice,
  worktreeIdentity,
} from "../../../../scripts/voice-app.mjs";

const desktopDir = join(repoDir, "apps/desktop");
const helperDir = join(repoDir, "native/voice-helper");
const worktree = realpathSync(repoDir);
const worktreeId = worktreeIdentity(worktree);
const userDataPath = scratchPath("voice-verify", worktree);
const statePath = `${userDataPath}.json`;
const savedClipboardPath = `${userDataPath}.clipboard.json`;
const evidenceRoot = join(tmpdir(), "voice-verify-evidence", worktreeId);

const [command = "help", ...args] = process.argv.slice(2);
const show = (value) => JSON.stringify(value);
const out = (value) =>
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
const fail = (message) => {
  throw new Error(message);
};

const scenarioOwner = args.find((arg) => arg.startsWith("--scenario-owner="))?.split("=")[1];

class VerificationBlocked extends Error {
  constructor(message, prerequisites) {
    super(message);
    this.prerequisites = prerequisites;
  }
}

function runVerifier(argv, { signal, timeout = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [fileURLToPath(import.meta.url), ...argv],
      { timeout, detached: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        try {
          const result = JSON.parse(stdout);
          if (error && result.status === "BLOCKED")
            return reject(new VerificationBlocked(result.error, result.prerequisites));
          if (!error) return resolve(result);
        } catch (parseError) {
          if (!error) return reject(parseError);
        }
        reject(new Error(`${argv[0]} failed: ${stderr || error.message}`));
      },
    );
    const interrupt = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", interrupt, { once: true });
    child.once("close", () => signal?.removeEventListener("abort", interrupt));
    if (signal?.aborted) interrupt();
  });
}

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function publishState(state, claim = false) {
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2), { flag: "wx" });
    if (claim) linkSync(temporary, statePath);
    else renameSync(temporary, statePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// An instance another run now owns blocks a scenario; one this run owns that is gone fails it.
function requireInstance(owner = scenarioOwner) {
  const state = readState();
  if (owner && state?.scenarioOwner !== owner)
    throw new VerificationBlocked("scenario lost ownership of its instance", {
      instance: [state ?? "none"],
    });
  if (!state?.port || !sameProcess(state.electronPid, state.electronIdentity)) {
    fail(
      owner
        ? `the scenario's Voice instance exited; see ${state.logPath}`
        : "no ready verify instance; start one with `voice-verify.mjs launch` and wait for ready",
    );
  }
  return state;
}

// The meeting notepad exists only while it is open.
const PAGES = new Set(["hub", "pill", "notepad"]);

async function connect(which) {
  const state = requireInstance();
  return Page.connect(state.port, `${which}.html`, { timeoutMs: 5000 });
}

function evidenceDir() {
  const dir = join(evidenceRoot, requireInstance().runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function otherVoiceProcesses(ownUserData) {
  return runningVoiceProcesses().filter((line) => !ownUserData || !line.includes(ownUserData));
}

async function waitOn(page, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    // A matched element is truthy but cannot be returned by value.
    last = await page.evaluate(
      `Promise.resolve(${expression}).then((v) => (v instanceof Node ? true : v), () => false)`,
    );
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${expression} (last ${show(last)})`);
}

// Meeting fixtures play this many times faster than real time.
const MEETING_FIXTURE_SPEED = 8;

const meetingWords = (text) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

// A user turn survives when the mic segments around it hold most of its words. A system turn of
// four or more words is echo kept when mic segments that start while it plays repeat most of its
// words beyond the user's own; a user repeating it after it ends is not echo.
function scoreMeeting(turns, segments) {
  const wordsOf = (filter) =>
    segments
      .filter((entry) => entry.source === "mic" && filter(entry))
      .flatMap((entry) => meetingWords(entry.text));
  const share = (words, heard) => words.filter((word) => heard.has(word)).length / words.length;
  const userTurns = turns.filter((turn) => turn.source === "mic");
  const lost = userTurns
    .filter((turn) => {
      const heard = new Set(
        wordsOf(
          (entry) => entry.startMs <= turn.endMs + 1500 && entry.endMs >= turn.startMs - 1500,
        ),
      );
      return share(meetingWords(turn.text), heard) < 0.6;
    })
    .map((turn) => turn.text);
  const echoKept = turns
    .filter((turn) => turn.source === "system" && meetingWords(turn.text).length >= 4)
    .filter((turn) => {
      const own = new Set(
        userTurns
          .filter((user) => user.startMs <= turn.endMs && user.endMs >= turn.startMs)
          .flatMap((user) => meetingWords(user.text)),
      );
      const heard = new Set(
        wordsOf(
          (entry) => entry.startMs >= turn.startMs - 1000 && entry.startMs <= turn.endMs - 500,
        ),
      );
      const words = meetingWords(turn.text).filter((word) => !own.has(word));
      return words.length > 0 && share(words, heard) >= 0.6;
    })
    .map((turn) => turn.text);
  return { userTurns: userTurns.length, userTurnsLost: lost, echoKept };
}

async function pollAsync(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined) return result;
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
}

async function poll(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = check();
    if (result !== undefined) return result;
    await sleep(50);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
}

const newest = (dir) => {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.parentPath.includes("node_modules")) continue;
    latest = Math.max(latest, statSync(join(entry.parentPath, entry.name)).mtimeMs);
  }
  return latest;
};
const mtime = (path) => (existsSync(path) ? statSync(path).mtimeMs : 0);

// A second copy of Voice on the instance's userData, as when the user opens Voice again.
function openSecondCopy(state, ...extraArgs) {
  const env = smokeEnvironment(state.userData, {
    VOICE_HELPER_TEST_AUDIO: state.fakeMicrophonePath,
  });
  return spawnSync(electronPath(), [".", ...extraArgs], { cwd: desktopDir, env, timeout: 30_000 });
}

function exclusiveDesktop(state, { recheckInstance = false } = {}) {
  const check = () => {
    if (recheckInstance) requireInstance();
    const others = otherVoiceProcesses(state.userData);
    if (others.length > 0)
      throw new VerificationBlocked(CONTENDING_VOICE_MESSAGE, { desktop: others });
  };
  const fnpost = (...keys) => {
    check();
    execFileSync(join(helperDir, ".build/debug/fnpost"), keys, { stdio: "ignore" });
  };
  return { check, fnpost };
}

function interruptible(message) {
  let interrupt;
  const interrupted = new Promise((_, reject) => {
    interrupt = () => reject(new Error(message));
  });
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  process.on("SIGHUP", interrupt);
  return {
    wait: (promise) => Promise.race([promise, interrupted]),
    release() {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      process.removeListener("SIGHUP", interrupt);
    },
  };
}

async function armTransform({ hub, snapshots, target, wait }) {
  await wait(target.open(TRANSFORM_PARAGRAPH));
  await wait(target.selectAll());
  const before = await wait(target.read());
  await wait(target.front());
  await wait(
    waitOn(hub, "!document.hasFocus()", 3000).catch(() =>
      fail("the Voice window kept focus, so no shortcut is registered"),
    ),
  );
  await wait(
    snapshots.waitFor((s) => s.session.kind === "idle", {
      timeoutMs: 5000,
      label: "an idle Flow Bar before the shortcut",
    }),
  );
  return before;
}

async function pressTransform({ desktop, snapshots, keycode, escape, wait }) {
  const pressedAt = Date.now();
  desktop.fnpost("combo", String(keycode), "option", "--side=left");
  const started = await wait(
    snapshots.waitFor((s) => ["transforming", "transformDone"].includes(s.session.kind), {
      timeoutMs: 5000,
      label: "a transform run after the shortcut (Transforms on, target frontmost)",
    }),
  );
  const runFrom = snapshots.items.indexOf(started);
  let escapedAfterMs = null;
  if (shouldEscape(escape, started.session.kind)) {
    await wait(sleep(400));
    if (shouldEscape(escape, snapshots.items.at(-1).session.kind)) {
      desktop.fnpost("escape");
      escapedAfterMs = Date.now() - pressedAt;
    }
  }
  return { pressedAt, started, runFrom, escapedAfterMs };
}

async function followTransform({ snapshots, state, logOffset, pressed, wait }) {
  const { started, runFrom, pressedAt } = pressed;
  const finished =
    started.session.kind === "transformDone"
      ? started
      : await wait(
          snapshots.waitFor((s) => ["transformDone", "idle"].includes(s.session.kind), {
            timeoutMs: 150_000,
            label: "the transform to finish",
          }),
        );
  const finishedMs = Date.now() - pressedAt;
  const run = snapshots.items.slice(runFrom);
  const newLog = () => readFileSync(state.logPath).subarray(logOffset).toString("utf8");
  const logged = await wait(
    poll(() => transformLogLine(newLog()) ?? undefined, 5000, "transform line").catch(() => null),
  );
  return { finished, finishedMs, run, logged };
}

async function collectTransform({ hub, target, outcome, pressedAt, clipboardSaved, wait }) {
  const last = await wait(hub.evaluate("window.voice.getLastTransform()").catch(() => null));
  const lastTransform = freshLast(last, pressedAt);
  const expected = expectedLanding(outcome, lastTransform);
  const { text: after, landedMs } =
    expected === null
      ? { text: await wait(target.read()), landedMs: null }
      : await wait(landedText(() => target.read(), expected, { timeoutMs: 2000 }));
  const clipboardUnchanged = await wait(clipboardKept(clipboardSaved));
  return { lastTransform, after, landedMs, clipboardUnchanged };
}

const commands = {
  async doctor({ print = true } = {}) {
    const state = readState();
    const instance = state && sameProcess(state.electronPid, state.electronIdentity) ? state : null;
    let cdp = null;
    if (instance) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${instance.port}/json`)).json();
        cdp = targets.filter((t) => t.type === "page").map((t) => t.url.split("/").at(-1));
      } catch (error) {
        cdp = `unreachable: ${error.message}`;
      }
    }
    const appBuilt = mtime(join(desktopDir, "dist-electron/main.cjs"));
    const appSource = Math.max(
      newest(join(desktopDir, "src")),
      newest(join(repoDir, "packages/cleanup/src")),
    );
    const helperBuilt = mtime(join(helperDir, ".build/debug/voice-helper"));
    const helperSource = newest(join(helperDir, "Sources"));
    const cache =
      process.env.VOICE_TEST_MODELS_DIR ??
      join(homedir(), "Library/Caches/Voice Development/test-models");
    const report = {
      node: process.version,
      dependencies: {
        workspace: existsSync(join(repoDir, "node_modules"))
          ? "installed"
          : "missing: run pnpm install",
        electron: electronDependency().status,
      },
      app: !appBuilt
        ? "not built: run pnpm build"
        : appBuilt < appSource
          ? "stale: run pnpm build"
          : "built",
      helper: !helperBuilt
        ? "not built: run swift build --package-path native/voice-helper"
        : helperBuilt < helperSource
          ? "stale: run swift build --package-path native/voice-helper"
          : "built",
      fnpost: existsSync(join(helperDir, ".build/debug/fnpost")) ? "built" : "missing",
      fixtures: existsSync(join(fixturesDir, "short.wav"))
        ? "present"
        : "missing: run node scripts/fixtures.mjs",
      testModels: Object.fromEntries(
        Object.entries(modelFiles).map(([id, file]) => [
          id,
          existsSync(join(cache, file)) ? "cached" : "will download",
        ]),
      ),
      optionalTestModels: Object.fromEntries(
        Object.entries(optionalModelFiles).map(([id, file]) => [
          id,
          existsSync(join(cache, file)) ? "cached" : "missing",
        ]),
      ),
      instance: instance
        ? { ...instance, cdpPages: cdp }
        : state
          ? sameProcess(state.ownerPid, state.ownerIdentity)
            ? `launching: ${show(state)}`
            : "stale instance record; run voice-verify.mjs stop"
          : "none",
      otherVoiceProcesses: otherVoiceProcesses(instance?.userData),
    };
    if (instance && Array.isArray(cdp)) {
      const hub = await connect("hub");
      const s = await hub.evaluate("window.voice.getSnapshot()");
      hub.close();
      report.snapshot = { session: s.session, permissions: s.permissions, models: s.models };
    }
    if (print) out(report);
    return report;
  },

  async launch() {
    electronPath();
    const existing = readState();
    if (
      existing &&
      (sameProcess(existing.ownerPid, existing.ownerIdentity) ||
        sameProcess(existing.electronPid, existing.electronIdentity))
    )
      fail(`this worktree's instance is already running: ${show(existing)}`);
    if (!existsSync(join(desktopDir, "dist-electron/main.cjs")))
      fail("app not built: run pnpm build");

    // --keep-user-data relaunches on the folder a `stop --keep-user-data` left, to test a restart.
    const keptUserData = userDataPath;
    const keep = args.includes("--keep-user-data");
    if (keep && !existsSync(keptUserData))
      fail("no kept userData; run stop --keep-user-data first");

    const state = {
      ownerPid: process.pid,
      ownerIdentity: processIdentity(process.pid),
      worktree,
      userData: keptUserData,
      ...(scenarioOwner && { scenarioOwner }),
    };
    const save = () => publishState(state);
    try {
      publishState(state, true);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      fail("this worktree has an instance record; run stop before relaunching");
    }
    let stopping = false;
    let ownsScratch = false;
    const shutdown = async (code) => {
      if (stopping) return;
      stopping = true;
      await stopChildren();
      if (ownsScratch) await releaseUserData(keptUserData);
      process.exit(code);
    };
    process.on("SIGINT", () => void shutdown(130));
    process.on("SIGTERM", () => void shutdown(0));
    process.on("SIGHUP", () => void shutdown(129));

    try {
      const userData = keep
        ? (await claimScratch(keptUserData)).userData
        : await prepareUserData("voice-verify");
      ownsScratch = true;
      if (stopping) return;
      const fakeMicrophonePath = join(userData, "capture.wav");
      const meetingMicPath = join(userData, "meeting-mic.wav");
      const meetingSystemPath = join(userData, "meeting-system.wav");
      const meetingOutputPath = join(userData, "meeting-output.txt");
      const logPath = join(userData, "main.log");
      const { child, ports: announced } = launchVoice(userData, {
        inspect: true,
        env: {
          VOICE_HELPER_TEST_AUDIO: fakeMicrophonePath,
          VOICE_HELPER_TEST_MEETING_MIC: meetingMicPath,
          VOICE_HELPER_TEST_MEETING_SYSTEM: meetingSystemPath,
          VOICE_HELPER_TEST_MEETING_OUTPUT: meetingOutputPath,
          VOICE_HELPER_TEST_MEETING_SPEED: String(MEETING_FIXTURE_SPEED),
        },
      });
      child.stdout.on("data", (chunk) => appendFileSync(logPath, chunk));
      child.stderr.on("data", (chunk) => appendFileSync(join(userData, "stderr.log"), chunk));
      child.on("exit", (code, signal) => {
        if (stopping) return;
        console.error(
          `voice-verify: Voice exited (code ${code}, signal ${signal}); see ${logPath}`,
        );
        void shutdown(1);
      });
      Object.assign(state, {
        electronPid: child.pid,
        electronIdentity: processIdentity(child.pid),
        userData,
        fakeMicrophonePath,
        meetingMicPath,
        meetingSystemPath,
        meetingOutputPath,
        logPath,
      });
      save();

      const ports = await announced;
      const runId = new Date().toISOString().replace(/[:.]/g, "-");
      Object.assign(state, {
        port: ports.DevTools,
        inspectPort: ports.Debugger,
        runId,
        evidence: join(evidenceRoot, runId),
      });
      save();
      const hub = await Page.connect(state.port, "hub.html");
      await Page.connect(state.port, "pill.html").then((pill) => pill.close());
      const snapshots = await snapshotStream(hub);
      const permissions = await snapshots.waitFor(
        (s) => s.permissions.accessibility !== "notDetermined",
        {
          timeoutMs: 15_000,
          label: "permission report",
        },
      );
      let models;
      try {
        models = (
          await snapshots.waitFor(
            (s) =>
              ["ready", "failed"].includes(s.models.asr.state) &&
              ["ready", "failed"].includes(s.models.cleanup.state),
            { timeoutMs: 180_000, label: "models settled" },
          )
        ).models;
      } catch {
        models = snapshots.items.at(-1).models;
      }
      hub.close();
      out({ ready: true, ...state, permissions: permissions.permissions, models });
    } catch (error) {
      console.error(
        `voice-verify: launch failed: ${error.message}; see main.log and stderr.log in ${state.userData}`,
      );
      await shutdown(1);
    }
  },

  stop() {
    const result = spawnSync(
      "/usr/bin/lockf",
      [
        "-k",
        "-t",
        "0",
        `${statePath}.stop-lock`,
        process.execPath,
        fileURLToPath(import.meta.url),
        "_stop",
        ...args,
      ],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status === 75) fail("stop already in progress; retry after it finishes");
    if (result.status !== 0) process.exit(result.status ?? 1);
  },

  async _stop() {
    const state = readState();
    if (!state) return out("no verify instance recorded");
    if (scenarioOwner && state.scenarioOwner !== scenarioOwner)
      fail("refusing to stop an instance owned by another run");
    const keep = args.includes("--keep-user-data");
    if (sameProcess(state.ownerPid, state.ownerIdentity)) {
      process.kill(state.ownerPid, "SIGTERM");
      for (let i = 0; i < 100 && sameProcess(state.ownerPid, state.ownerIdentity); i += 1) {
        await sleep(100);
      }
    }
    if (sameProcess(state.ownerPid, state.ownerIdentity))
      throw new Error("verify owner did not stop; instance record and userData retained");
    if (sameProcess(state.electronPid, state.electronIdentity)) {
      signalGroup(state.electronPid, "SIGTERM");
      await sleep(3000);
      if (sameProcess(state.electronPid, state.electronIdentity))
        signalGroup(state.electronPid, "SIGKILL");
      for (let i = 0; i < 100 && sameProcess(state.electronPid, state.electronIdentity); i += 1)
        await sleep(50);
      if (sameProcess(state.electronPid, state.electronIdentity))
        throw new Error("verify Electron did not stop; instance record and userData retained");
    }
    if (readState()?.ownerPid === state.ownerPid) {
      const claim = await claimScratch(userDataPath);
      await claim.release({ remove: !keep });
      rmSync(statePath, { force: true });
    }
    out({
      stopped: state.runId ?? "launching",
      evidence: state.evidence && existsSync(state.evidence) ? state.evidence : "none captured",
      ...(keep && { keptUserData: state.userData }),
    });
  },

  async scenario() {
    const [name] = args;
    const scenario = scenarioNamed(name);
    if (args.length !== 1) fail("usage: scenario <name>");
    const prerequisites = scenarioPrerequisites(await commands.doctor({ print: false }));
    const blocked = () => Object.values(prerequisites).some((items) => items.length > 0);
    if (blocked()) {
      out({ scenario: name, status: "BLOCKED", prerequisites });
      fail("BLOCKED: resolve the reported scenario prerequisites first");
    }

    const token = randomUUID();
    const ownershipFlag = `--scenario-owner=${token}`;
    const abort = new AbortController();
    let rejectInterrupt;
    const interrupted = new Promise((_, reject) => {
      rejectInterrupt = reject;
    });
    const wait = (promise) => Promise.race([promise, interrupted]);
    // The handlers stay until the command exits: a second Ctrl+C must not leave the instance running
    // or end the command by signal instead of with its scenario status.
    const interrupt = (signal) => {
      if (abort.signal.aborted) {
        console.error(`voice-verify: ${signal} ignored; the scenario is tearing down its instance`);
        return;
      }
      const error = new Error("scenario interrupted");
      abort.abort(error);
      rejectInterrupt(error);
    };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    process.on("SIGHUP", interrupt);
    let state;
    let readiness;
    let hub;
    let cleanupWrapped = false;
    let failure;
    const sessions = [];
    try {
      const launcher = start(
        process.execPath,
        [fileURLToPath(import.meta.url), "launch", ownershipFlag],
        {
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
      let output = "";
      launcher.stdout.on("data", (chunk) => {
        output += chunk;
      });
      let launchError;
      launcher.on("error", (error) => {
        launchError = error;
      });
      state = await wait(
        poll(
          () => {
            abort.signal.throwIfAborted();
            if (launchError) throw launchError;
            if (launcher.exitCode !== null || launcher.signalCode !== null)
              throw new Error("scenario launch exited before readiness");
            let ready;
            try {
              ready = JSON.parse(output);
            } catch {
              return undefined;
            }
            return ready.ready ? ready : undefined;
          },
          240_000,
          "scenario launch readiness",
        ),
      );
      if (state.scenarioOwner !== token) fail("scenario launch returned another run's instance");
      requireInstance(token);

      hub = await wait(Page.connect(state.port, "hub.html"));
      const snapshot = await wait(hub.evaluate("window.voice.getSnapshot()"));
      readiness = { models: snapshot.models, permissions: snapshot.permissions };
      prerequisites.models = [
        ["asr", snapshot.models.asr],
        ["cleanup", snapshot.models.cleanup],
      ].filter(([, model]) => model.state !== "ready");
      prerequisites.permissions =
        snapshot.permissions.accessibility === "granted"
          ? []
          : [["accessibility", snapshot.permissions.accessibility]];
      prerequisites.desktop = otherVoiceProcesses(state.userData);
      if (blocked())
        throw new VerificationBlocked(
          "models, Accessibility, or exclusive desktop access unavailable",
          prerequisites,
        );
      requireInstance(token);
      await wait(hub.evaluate(`window.voice.updateSettings(${show(scenarioSettings(name))})`));

      if (name === "cleanup-failure") {
        requireInstance(token);
        cleanupWrapped = true;
        await wait(
          evaluateInMain(
            state.inspectPort,
            `(() => {
          const test = globalThis.voiceTest;
          if (test.__verifyCleanup) throw new Error("cleanup probe already installed");
          const original = test.cleanup.clean;
          const counts = { failures: 0, successes: 0 };
          test.__verifyCleanup = { read: () => ({ ...counts }) };
          test.cleanup.clean = async (...args) => {
            if (counts.failures === 0) {
              counts.failures++;
              throw new Error("Synthetic cleanup rejection");
            }
            const result = await original.apply(test.cleanup, args);
            counts.successes++;
            return result;
          };
          return true;
        })()`,
          ),
        );
      }

      const dictate = async (check) => {
        abort.signal.throwIfAborted();
        requireInstance(token);
        const previousIds = await wait(
          hub.evaluate("window.voice.getHistory().then(h => h.entries.map(e => e.id))"),
        );
        const result = await runVerifier(["dictate", "short.wav", "--key=toggle", ownershipFlag], {
          signal: abort.signal,
        });
        abort.signal.throwIfAborted();
        requireInstance(token);
        const probe = cleanupWrapped
          ? await wait(
              evaluateInMain(state.inspectPort, "globalThis.voiceTest.__verifyCleanup.read()"),
            )
          : undefined;
        sessions.push({ ...result, previousIds, ...(probe && { probe }) });
        check(result, previousIds, probe);
      };
      await dictate(scenario.assert);
      if (scenario.assertRecovery) await dictate(scenario.assertRecovery);
    } catch (error) {
      failure = error;
      if (error instanceof VerificationBlocked) Object.assign(prerequisites, error.prerequisites);
    } finally {
      try {
        try {
          hub?.close();
        } finally {
          await stopChildren();
          if (readState()?.scenarioOwner === token) await runVerifier(["stop", ownershipFlag]);
        }
      } catch (error) {
        failure = new AggregateError([failure, error].filter(Boolean), "scenario teardown failed");
      }
    }
    const report = {
      scenario: name,
      status: failure ? (failure instanceof VerificationBlocked ? "BLOCKED" : "FAIL") : "PASS",
      worktree,
      prerequisites,
      readiness,
      sessions,
      ...(failure && { error: failure.stack }),
    };
    if (state?.evidence) {
      mkdirSync(state.evidence, { recursive: true });
      report.evidence = join(state.evidence, `scenario-${name}.json`);
      writeFileSync(report.evidence, JSON.stringify(report, null, 2));
    }
    out(report);
    if (failure) throw failure;
  },

  async snapshot() {
    const hub = await connect("hub");
    out(await hub.evaluate("window.voice.getSnapshot()"));
    hub.close();
  },

  async text() {
    const hub = await connect("hub");
    out(
      await hub.evaluate(`(() => {
        const modal = document.querySelector("[data-app-modal][data-open]");
        const nav = (modal ?? document.querySelector("aside"))?.querySelector("nav");
        const current = nav?.querySelector('[aria-current="page"]');
        const content = modal
          ? [...modal.children].filter((part) => !part.contains(nav)).map((part) => part.innerText).join("\\n")
          : document.querySelector("main").innerText;
        return "[" + (nav?.getAttribute("aria-label") ?? "?") + " nav" + (current ? " > " + current.textContent.trim() : "") + "]\\n" + content;
      })()`),
    );
    hub.close();
  },

  async eval() {
    const [which, expression] = args;
    if (!PAGES.has(which) || !expression) fail("usage: eval <hub|pill|notepad> <expression>");
    const page = await connect(which);
    out(await page.evaluate(expression));
    page.close();
  },

  async callback() {
    const [code] = args;
    if (!code) fail("usage: callback <code>");
    const state = requireInstance();
    const url = `com.codlume.voice://auth/callback#token=${code}`;
    // The landing page opens this URL. A development build cannot receive it from macOS, so the
    // main-process test hook emits the same open-url event the OS would.
    await evaluateInMain(state.inspectPort, `globalThis.voiceTest.openUrl(${show(url)})`);
    out({ delivered: url.replace(/#token=.*/, "#token=<code>") });
  },

  async menu() {
    const [id] = args;
    if (!id) fail("usage: menu <menu item id>");
    // CDP key events never reach the native menu, so this chooses the item the way its shortcut does.
    await evaluateInMain(
      requireInstance().inspectPort,
      `globalThis.voiceTest.clickMenuItem(${show(id)})`,
    );
    out({ clicked: id });
  },

  async tray() {
    const [id] = args;
    const inspectPort = requireInstance().inspectPort;
    // No script can click the menu bar, so this lists or chooses the tray menu's items in main.
    if (id) await evaluateInMain(inspectPort, `globalThis.voiceTest.clickTrayItem(${show(id)})`);
    out({
      ...(id ? { clicked: id } : {}),
      items: await evaluateInMain(inspectPort, "globalThis.voiceTest.trayItems()"),
    });
  },

  async reopen() {
    const state = requireInstance();
    const hubOpen = async () =>
      (await (await fetch(`http://127.0.0.1:${state.port}/json`)).json()).some((target) =>
        target.url.endsWith("hub.html"),
      );
    const hub = await connect("hub");
    await hub.evaluate("window.close()").catch(() => {});
    hub.close();
    for (let i = 0; i < 50 && (await hubOpen()); i += 1) {
      await sleep(100);
    }
    if (await hubOpen()) fail("the Voice window did not close");
    // Opening Voice again starts a second copy, which hands over to the running one through the
    // single-instance lock. The running copy then shows its window, as for a user.
    const second = openSecondCopy(state);
    for (let i = 0; i < 100 && !(await hubOpen()); i += 1) {
      await sleep(100);
    }
    if (!(await hubOpen())) fail("the Voice window did not come back");
    out({ reopened: true, secondCopyExit: second.status });
  },

  async front() {
    // A covered window reports visibilityState "hidden" and stops animation frames, so closing
    // dialogs, menus, and outgoing tab panels stay in the DOM until it is painted again.
    await evaluateInMain(
      requireInstance().inspectPort,
      `(() => {
        const { app, BrowserWindow } = process.mainModule.require("electron");
        const hub = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("hub.html"));
        if (!hub) throw new Error("no Voice window; run reopen");
        app.focus({ steal: true });
        hub.show();
        hub.focus();
      })()`,
    );
    const hub = await connect("hub");
    await waitOn(hub, 'document.visibilityState === "visible"', 5000);
    hub.close();
    out({ front: true });
  },

  async "second-instance"() {
    const [code] = args;
    if (!code) fail("usage: second-instance <code>");
    const state = requireInstance();
    // The copy must lose the single-instance lock, hand its argv to the instance, and exit.
    const url = `com.codlume.voice://auth/callback#token=${code}`;
    const started = Date.now();
    const second = openSecondCopy(state, url);
    out({
      delivered: url.replace(/#token=.*/, "#token=<code>"),
      secondInstance: {
        pid: second.pid,
        exitCode: second.status,
        signal: second.signal,
        ms: Date.now() - started,
      },
      firstInstanceAlive: alive(state.electronPid),
    });
  },

  async wait() {
    const [which, expression, timeout = "10000"] = args;
    if (!PAGES.has(which) || !expression)
      fail("usage: wait <hub|pill|notepad> <expression> [timeoutMs]");
    const page = await connect(which);
    try {
      out(await waitOn(page, expression, Number(timeout)));
    } finally {
      page.close();
    }
  },

  async click() {
    const [target, which = "hub"] = args;
    if (!target) fail("usage: click <accessible name | css:selector> [hub|pill|notepad]");
    const page = await connect(which);
    try {
      const result = await waitOn(page, clickExpression(target), 5000);
      if (result.ambiguous)
        fail(
          `${show(target)} matches ${result.ambiguous.length} elements: ${show(result.ambiguous)}`,
        );
      out(result);
    } finally {
      page.close();
    }
  },

  async type() {
    const [target, ...words] = args;
    if (!target || words.length === 0) fail("usage: type <css:selector> <text...>");
    const selector = target.replace(/^css:/, "");
    const text = words.join(" ");
    const page = await connect("hub");
    try {
      const matches = await page.evaluate(`(() => {
        const matches = [...document.querySelectorAll(${show(selector)})].filter(${visible});
        if (matches.length === 1) matches[0].focus();
        return { count: matches.length, focused: matches.length === 1 && document.activeElement === matches[0] };
      })()`);
      if (matches.count !== 1)
        fail(`${show(selector)} matches ${matches.count} visible elements; expected one`);
      if (!matches.focused) fail(`${show(selector)} did not take focus`);
      // insertText goes through the browser's input pipeline, so React sees it as a paste.
      await page.call("Input.insertText", { text });
      out({ typed: text.length });
    } finally {
      page.close();
    }
  },

  async key() {
    const [code, ...modifiers] = args;
    if (!code) fail("usage: key <code> [option|shift|control|command…]");
    let events;
    try {
      events = keyEvents(code, modifiers);
    } catch (error) {
      fail(error.message);
    }
    const page = await connect("hub");
    try {
      for (const event of events) await page.call("Input.dispatchKeyEvent", event);
      out({ pressed: code, modifiers });
    } finally {
      page.close();
    }
  },

  async browser() {
    const [googleCode = "ada-lovelace"] = args;
    const urlFile = join(requireInstance().userData, "sign-in-url.txt");
    if (!existsSync(urlFile)) fail("no pending sign-in; click Sign in with Google first");
    const signInUrl = readFileSync(urlFile, "utf8").trim();
    // A pending URL is good for one browser visit, like a real tab.
    rmSync(urlFile);
    const play = spawnSync(
      process.execPath,
      [
        join(repoDir, "apps/api/scripts/play-browser.mjs"),
        "--base",
        new URL(signInUrl).origin,
        "--init-url",
        signInUrl,
        "--code",
        googleCode,
      ],
      { encoding: "utf8" },
    );
    if (play.status !== 0) fail(`play-browser.mjs failed:\n${play.stdout}${play.stderr}`);
    out(play.stdout.trim());
  },

  async record() {
    const [name] = args;
    if (!name) fail("usage: record <name>");
    const output = join(evidenceDir(), `${name}.mp4`);
    const page = await connect("hub");
    const framesDir = mkdtempSync(join(tmpdir(), `voice-verify-${name}-`));
    const frames = [];
    page.on("Page.screencastFrame", ({ data: png, metadata, sessionId }) => {
      const file = join(framesDir, `${String(frames.length).padStart(6, "0")}.png`);
      writeFileSync(file, Buffer.from(png, "base64"));
      frames.push({ file, at: metadata.timestamp });
      void page.call("Page.screencastFrameAck", { sessionId });
    });
    await page.call("Page.startScreencast", {
      format: "png",
      everyNthFrame: 1,
      maxWidth: 960,
      maxHeight: 640,
    });
    out({ recording: output, pid: process.pid, stop: `kill -TERM ${process.pid}` });
    await new Promise((stopRecording) => {
      process.once("SIGINT", stopRecording);
      process.once("SIGTERM", stopRecording);
      void page.closed.then(stopRecording);
    });
    const stoppedAt = Date.now() / 1000;
    await Promise.race([page.call("Page.stopScreencast"), sleep(1000)]).catch(() => {});
    page.close();
    if (frames.length === 0) fail(`no frames captured; ${framesDir} is empty`);

    // The concat demuxer drops the last entry's duration unless the file is listed once more.
    const list = frames.flatMap(({ file, at }, index) => [
      `file '${file}'`,
      `duration ${Math.max(0.04, (frames[index + 1]?.at ?? stoppedAt) - at).toFixed(3)}`,
    ]);
    list.push(`file '${frames.at(-1).file}'`);
    const listPath = join(framesDir, "list.txt");
    writeFileSync(listPath, `${list.join("\n")}\n`);
    const ffmpeg = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-vsync",
        "vfr",
        "-pix_fmt",
        "yuv420p",
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        output,
      ],
      { encoding: "utf8" },
    );
    if (ffmpeg.error?.code === "ENOENT")
      return out({ frames: framesDir, count: frames.length, note: "ffmpeg not found" });
    if (ffmpeg.status !== 0) fail(`ffmpeg failed; frames kept in ${framesDir}\n${ffmpeg.stderr}`);
    rmSync(framesDir, { recursive: true, force: true });
    out({ video: output, frames: frames.length, seconds: +(stoppedAt - frames[0].at).toFixed(1) });
  },

  async shot() {
    const [name, which = "hub"] = args;
    if (!name) fail("usage: shot <name> [hub|pill|notepad]");
    const page = await connect(which);
    const { data } = await page.call("Page.captureScreenshot", { format: "png" });
    page.close();
    const path = join(evidenceDir(), `${name}.png`);
    writeFileSync(path, Buffer.from(data, "base64"));
    out(path);
  },

  clipboard() {
    const [action] = args;
    if (action === "save") {
      // A second save would replace the user's clipboard with whatever a recipe copied since.
      try {
        writeFileSync(savedClipboardPath, JSON.stringify(saveClipboard()), {
          mode: 0o600,
          flag: "wx",
        });
      } catch (error) {
        if (error.code === "EEXIST") fail("a saved clipboard is waiting; run clipboard restore");
        throw error;
      }
      out({ saved: true });
    } else if (action === "restore") {
      if (!existsSync(savedClipboardPath)) fail("no saved clipboard; run clipboard save first");
      const restored = restoreClipboard(JSON.parse(readFileSync(savedClipboardPath, "utf8")));
      rmSync(savedClipboardPath);
      out({ restored });
    } else {
      fail("usage: clipboard save|restore");
    }
  },

  async note() {
    const [name, ...rest] = args;
    if (!name || rest.length === 0) fail("usage: note <name> <text...>");
    const path = join(evidenceDir(), `${name}.txt`);
    appendFileSync(path, `${rest.join(" ")}\n`);
    out(path);
  },

  async meeting() {
    const [mic = "meeting-mic.wav", ...flags] = args.filter(
      (arg) => !arg.startsWith("--scenario-owner="),
    );
    const withSystem = !flags.includes("--no-system");
    const system =
      flags.find((flag) => flag.startsWith("--system="))?.slice("--system=".length) ??
      "meeting-system.wav";
    const headphones = flags.includes("--output=headphones");
    const state = requireInstance();
    if (!state.meetingMicPath) fail("this instance was launched before meeting support; relaunch");
    if (headphones && !state.meetingOutputPath)
      fail("this instance was launched before --output support; relaunch");
    const fixtures = [[join(fixturesDir, mic), state.meetingMicPath]];
    if (withSystem) fixtures.push([join(fixturesDir, system), state.meetingSystemPath]);
    for (const [fixture] of fixtures) {
      if (!existsSync(fixture)) fail(`missing fixture ${fixture}; run node scripts/fixtures.mjs`);
    }
    const turnsPath = join(fixturesDir, mic.replace(/-mic(-speakers)?\.wav$/, "-turns.json"));
    const turns = existsSync(turnsPath) ? JSON.parse(readFileSync(turnsPath, "utf8")) : null;
    const hub = await connect("hub");
    const logOffset = statSync(state.logPath).size;
    const newLog = () =>
      readFileSync(state.logPath).subarray(logOffset).toString("utf8").split("\n");
    const endedFixtures = () =>
      newLog().filter((line) => line.includes("helper info: meeting fixture ended")).length;
    const call = (expression) => hub.evaluate(expression);
    try {
      for (const [fixture, path] of fixtures) copyFileSync(fixture, path);
      if (state.meetingOutputPath) {
        if (headphones) writeFileSync(state.meetingOutputPath, "headphones");
        else rmSync(state.meetingOutputPath, { force: true });
      }
      const startedAt = performance.now();
      const started = await call("window.voice.startMeeting()");
      if (started.kind !== "ok") fail(`startMeeting: ${JSON.stringify(started)}`);
      const id = JSON.stringify(started.id);
      const status = () =>
        call(
          `window.voice.getMeetings().then((s) => s.meetings.find((m) => m.id === ${id})?.status.kind ?? null)`,
        );
      // Every live segment with when it first showed, until the final pass replaces them.
      const live = new Map();
      let replaced = false;
      const watchLive = async () => {
        if (replaced) return;
        const transcript = await call(`window.voice.getMeeting(${id}).then((d) => d.transcript)`);
        const segments = transcript.filter((entry) => entry.kind === "segment");
        const keys = new Set(
          segments.map((entry) => `${entry.source}@${entry.startMs}:${entry.text}`),
        );
        if ([...live.keys()].some((key) => !keys.has(key))) {
          replaced = true;
          return;
        }
        const now = performance.now() - startedAt;
        for (const entry of segments) {
          const key = `${entry.source}@${entry.startMs}:${entry.text}`;
          if (!live.has(key)) live.set(key, { ...entry, arrivedMs: Math.round(now) });
        }
      };
      const recording = await pollAsync(
        async () => ((await status()) === "recording" ? true : undefined),
        10_000,
        "meeting to record",
      );
      await pollAsync(
        async () => {
          await watchLive();
          return endedFixtures() >= fixtures.length ? true : undefined;
        },
        180_000,
        "meeting fixtures to finish",
      );
      const liveBeforeStop = live.size;
      await call(`window.voice.stopMeeting(${id})`);
      const stoppedAt = performance.now();
      let finished = await pollAsync(
        async () => {
          await watchLive();
          const kind = await status();
          return ["ready", "confirmingShort"].includes(kind) ? kind : undefined;
        },
        120_000,
        "meeting to finish",
      );
      if (finished === "confirmingShort") {
        await call(`window.voice.keepMeeting(${id})`);
        finished = await pollAsync(
          async () => ((await status()) === "ready" ? "ready" : undefined),
          120_000,
          "kept meeting to finish",
        );
      }
      const detail = await call(`window.voice.getMeeting(${id})`);
      const folder = join(state.userData, "meetings", started.id);
      const finalSegments = detail.transcript.filter((entry) => entry.kind === "segment");
      const liveSegments = [...live.values()];
      // How long after its speech ended each You line showed, in wall ms at the fixture speed.
      const youLatency = liveSegments
        .filter((entry) => entry.source === "mic")
        .map((entry) => Math.round(entry.arrivedMs - entry.endMs / MEETING_FIXTURE_SPEED));
      const result = {
        mic,
        system: withSystem && system,
        output: headphones ? "headphones" : "speakers",
        id: started.id,
        recording,
        liveEntriesBeforeStop: liveBeforeStop,
        status: finished,
        recordMs: Math.round(stoppedAt - startedAt),
        stopToReadyMs: Math.round(performance.now() - stoppedAt),
        firstYouLineMs: liveSegments.find((entry) => entry.source === "mic")?.arrivedMs ?? null,
        youLatencyMs: youLatency,
        echoDropped: newLog().filter((line) => line.includes("meeting echo dropped")).length,
        filesAfter: readdirSync(folder).toSorted(),
        speakers: detail.meeting.speakers.map((speaker) => `${speaker.id}: ${speaker.label}`),
        ...(turns && {
          live: scoreMeeting(turns, liveSegments),
          final: scoreMeeting(turns, finalSegments),
        }),
        liveTranscript: liveSegments.map(
          (entry) =>
            `+${entry.arrivedMs} ${entry.source}@${Math.round(entry.startMs)}-${Math.round(entry.endMs)}: ${entry.text}`,
        ),
        transcript: detail.transcript.map((entry) =>
          entry.kind === "segment"
            ? `${entry.source === "system" && entry.speakerId ? entry.speakerId : entry.source}@${Math.round(entry.startMs)}-${Math.round(entry.endMs)}: ${entry.text}`
            : `[${entry.marker}@${Math.round(entry.atMs)}]`,
        ),
      };
      const path = join(evidenceDir(), `meeting-${mic.replace(/\.wav$/, "")}-${Date.now()}.json`);
      writeFileSync(path, JSON.stringify(result, null, 2));
      out({ ...result, evidence: path });
    } finally {
      rmSync(state.meetingMicPath, { force: true });
      rmSync(state.meetingSystemPath, { force: true });
      if (state.meetingOutputPath) rmSync(state.meetingOutputPath, { force: true });
      hub.close();
    }
  },

  async dictate() {
    const [wav = "short.wav", ...flags] = args.filter(
      (arg) => !arg.startsWith("--scenario-owner="),
    );
    let parsed;
    try {
      parsed = parseDictateFlags(flags);
    } catch (error) {
      fail(error.message);
    }
    const { end, mode, app } = parsed;
    const state = requireInstance();
    const { check: checkAccess, fnpost } = exclusiveDesktop(state, {
      recheckInstance: Boolean(scenarioOwner),
    });
    checkAccess();
    const fixture = join(fixturesDir, wav);
    if (!existsSync(fixture)) fail(`missing fixture ${fixture}; run node scripts/fixtures.mjs`);

    const hub = await connect("hub");
    const { settings } = await hub.evaluate("window.voice.getSnapshot()");
    const key = mode === "toggle" ? settings.toggleHotkey : settings.hotkey;
    if (!key) fail("--key=toggle needs a toggle key: set Settings > Shortcuts > Toggle dictation");
    // A toggle session starts and ends on a tap, a press and release; a hold session spans the press.
    const begin = () => (mode === "toggle" ? fnpost(key) : fnpost(key, "down"));
    const finish = () => (mode === "toggle" ? fnpost(key) : fnpost(key, "up"));
    const snapshots = await snapshotStream(hub);
    const logOffset = statSync(state.logPath).size;
    const logLine = (pattern) =>
      readFileSync(state.logPath)
        .subarray(logOffset)
        .toString("utf8")
        .split("\n")
        .find((l) => pattern.test(l));
    const waitForLog = (pattern, timeoutMs, label) =>
      poll(() => logLine(pattern), timeoutMs, label);

    checkAccess();
    const { wait, release } = interruptible("dictation interrupted");
    let target;
    try {
      target = await electronTarget(state.userData, { wait });
      checkAccess();
      await wait(target.open());
      const newestEntry = () =>
        hub.evaluate("window.voice.getHistory().then((h) => h.entries[0] ?? null)");
      const previous = await wait(newestEntry());
      checkAccess();
      copyFileSync(fixture, state.fakeMicrophonePath);
      snapshots.skipToEnd();

      await wait(evaluateInMain(state.inspectPort, `globalThis.voiceTest.setTarget(${show(app)})`));
      begin();
      const pressedAt = performance.now();
      const listening = await wait(
        snapshots.waitFor((s) => s.session.kind === "listening", {
          timeoutMs: 5000,
          label: "listening",
        }),
      );
      const after = snapshots.items.indexOf(listening) + 1;
      const earlyEnd =
        end === "audio"
          ? await wait(
              poll(
                () =>
                  logLine(/helper info: test\.audioFile ended$/)
                    ? null
                    : snapshots.items.slice(after).find((s) => s.session.kind !== "listening"),
                60_000,
                "fixture to finish",
              ),
            )
          : null;
      const captureEndedEarly = earlyEnd && {
        afterMs: Math.round(performance.now() - pressedAt),
        session: earlyEnd.session.kind,
      };
      if (end === "escape") fnpost("escape");
      else finish();
      const heldMs = Math.round(performance.now() - pressedAt);
      let finalState;
      if (end === "escape") {
        finalState = await wait(
          snapshots.waitFor((s) => s.session.kind === "idle", {
            timeoutMs: 5000,
            label: "idle",
          }),
        );
        if (mode === "hold") fnpost(key, "up");
      } else {
        finalState = await wait(
          snapshots.waitFor((s) => ["done", "idle"].includes(s.session.kind), {
            timeoutMs: 90_000,
            label: "done",
          }),
        );
      }
      const read = () => target.read();
      // A session without a transcript (escape, tooShort, empty) leaves the previous entry newest.
      const current = await wait(newestEntry());
      const latest = current?.id === previous?.id ? null : current;
      const landing =
        finalState.session.outcome?.kind === "inserted" && latest
          ? landedText(read, latest.text)
          : Promise.resolve({ text: await read(), landedMs: null });
      const [{ text: inserted, landedMs }, timing] = await wait(
        Promise.all([
          landing,
          end === "escape"
            ? null
            : waitForLog(/\[voice\] session \w+ outcome=/, 5000, "timing line").catch(() => null),
        ]),
      );
      const result = {
        fixture: wav,
        end,
        mode,
        hotkey: key,
        ...(app && { app }),
        cleanup: settings.cleanup,
        heldMs,
        ...(captureEndedEarly && { captureEndedEarly }),
        outcome: finalState.session.outcome ?? finalState.session.kind,
        inserted,
        landedMs,
        latest,
        timing: timing?.replace(/^.*\[voice\] /, "") ?? null,
      };
      const path = join(
        evidenceDir(),
        `dictate-${wav.replace(/\.wav$/, "")}-${mode}-${end}-${Date.now()}.json`,
      );
      writeFileSync(path, JSON.stringify(result, null, 2));
      out({ ...result, evidence: path });
      if (captureEndedEarly) {
        throw new Error(
          `capture ended by ${captureEndedEarly.afterMs} ms after the press, before ${wav} finished, before dictate ended it`,
        );
      }
    } finally {
      if (!scenarioOwner || readState()?.scenarioOwner === scenarioOwner)
        rmSync(state.fakeMicrophonePath, { force: true });
      await target?.close();
      hub.close();
      await stopChildren();
      release();
    }
  },

  async transform() {
    let flags;
    try {
      flags = parseTransformFlags(args);
    } catch (error) {
      fail(error.message);
    }
    const { target: targetKind, keycode, escape } = flags;
    const state = requireInstance();
    const desktop = exclusiveDesktop(state);
    desktop.check();
    const hub = await connect("hub");
    const { wait, release } = interruptible("transform interrupted");
    let target;
    let clipboardSaved;
    try {
      const { settings, models } = await wait(hub.evaluate("window.voice.getSnapshot()"));
      const transform = optionShortcutTransform(settings.transforms, keycode);
      const snapshots = await snapshotStream(hub);
      const logOffset = statSync(state.logPath).size;
      clipboardSaved = saveClipboard();

      desktop.check();
      target =
        targetKind === "textedit"
          ? textEditTarget("transform")
          : await electronTarget(state.userData, { wait });
      const before = await armTransform({ hub, snapshots, target, wait });
      const pressed = await pressTransform({ desktop, snapshots, keycode, escape, wait });
      const followed = await followTransform({ snapshots, state, logOffset, pressed, wait });
      const { outcome, outcomeFrom } = resolveOutcome(followed.finished, followed.logged);
      const collected = await collectTransform({
        hub,
        target,
        outcome,
        pressedAt: pressed.pressedAt,
        clipboardSaved,
        wait,
      });

      const result = {
        target: targetKind,
        transform: transform.name,
        shortcut: { keycode, modifiers: ["option"], side: "left" },
        escapedAfterMs: pressed.escapedAfterMs,
        modelAtPress: models.transform.state,
        pill: pillSummary(followed.run, followed.finished),
        outcome,
        outcomeFrom,
        finishedMs: followed.finishedMs,
        before,
        after: collected.after,
        landedMs: collected.landedMs,
        lastTransform: collected.lastTransform,
        clipboardUnchanged: collected.clipboardUnchanged,
        logLine: followed.logged?.line ?? null,
      };
      const path = join(
        evidenceDir(),
        `transform-${targetKind}${escape ? "-escape" : ""}-${Date.now()}.json`,
      );
      writeFileSync(path, JSON.stringify(result, null, 2));
      out({ ...result, evidence: path });
      if (!outcome) fail("the run ended without a transformDone pill or a transform log line");
    } finally {
      try {
        await target?.close();
        if (clipboardSaved && restoreClipboard(clipboardSaved))
          console.error("restored the clipboard saved before the transform");
      } finally {
        hub.close();
        await stopChildren();
        release();
      }
    }
  },

  help() {
    out(`usage: node .claude/skills/verify/scripts/voice-verify.mjs <command>
  doctor                         read-only health report
  scenario <short-dictation|cleanup-failure|dictionary-word|snippet-expansion>
                                 launch, assert synthetic dictation, and tear down an owned instance
  launch [--keep-user-data]      start this worktree's disposable instance (foreground; run in background);
                                 the flag reuses the userData a stop --keep-user-data left
  stop [--keep-user-data]        tear down this worktree's instance; evidence survives,
                                 and with the flag so does the scratch userData
  snapshot                       full app snapshot JSON
  text                           current nav and visible page text, or Settings while it is open
  click <name|css:sel> [page]    click the one visible element with that accessible name
  type <css:sel> <text...>       focus the one visible hub element and insert text as a paste
  key <code> [modifier...]       press one key in the hub, e.g. key Digit1 option (modifiers: option shift control command)
  browser [google-code]          play the browser's part of a pending sign-in (apps/api/scripts/play-browser.mjs)
  callback <code>                deliver the landing page's com.codlume.voice:// URL to the main process
  menu <id>                      choose an application menu item by id, as its shortcut would
  tray [id]                      list the menu bar items, or choose one by id (meeting)
  second-instance <code>         launch a second Voice with that URL as its argument; print its exit
  reopen                         close the Voice window, then open Voice again (second copy hands over)
  front                          bring the Voice window in front of other apps and wait until it paints
  record <name>                  screencast the hub to <name>.mp4 until SIGTERM (foreground; run in background)
  wait <page> <expr> [ms]        poll a page expression until truthy
  eval <page> <expr>             evaluate in hub or pill, print the result
  shot <name> [page]             screenshot into the evidence dir
  note <name> <text...>          append text evidence
  clipboard save|restore         keep every type on the clipboard in a private file, then put it back
  dictate [fixture.wav] [--end=audio|escape|immediate] [--key=hold|toggle] [--app=<bundleId>[@host]]
                                 --app makes the helper report that target app for the session
  transform [--target=electron|textedit] [--shortcut=<keycode>] [--escape]
                                 select a synthetic paragraph in the target, press Left Option+key, report the run`);
  },
};

try {
  if (!Object.hasOwn(commands, command)) fail(`unknown command ${command}; try help`);
  await commands[command]();
} catch (error) {
  if (["dictate", "transform"].includes(command) && error instanceof VerificationBlocked)
    out({ status: "BLOCKED", prerequisites: error.prerequisites, error: error.message });
  console.error(`voice-verify: ${error.stack}`);
  process.exitCode = 1;
}
if (command !== "launch") process.exit(process.exitCode ?? 0);

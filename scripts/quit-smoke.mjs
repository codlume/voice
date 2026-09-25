#!/usr/bin/env node
import { rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  electronPath,
  Page,
  prepareUserData,
  repoDir,
  start,
  stopChildren,
  stopChildrenOnSignal,
  Stream,
} from "./voice-app.mjs";

const ports = { cdp: 9446, inspect: 9447 };
const EXIT_TIMEOUT_MS = 10_000;
const MODEL_TIMEOUT_MS = 120_000;
const CRASH_SIGNATURE = "terminating due to uncaught exception";

const { values: args } = parseArgs({
  options: {
    trials: { type: "string", default: "5" },
    mode: { type: "string" },
  },
});
const trials = Number(args.trials);
const modes = args.mode ? [args.mode] : ["ready", "loading"];
for (const mode of modes) {
  if (mode !== "ready" && mode !== "loading") throw new Error(`unknown mode ${mode}`);
}

const note = (message) => console.error(`[quit-smoke] ${message}`);

// After two unclean exits AppKit blocks the next launch of the same bundle id behind a modal
// "restore windows?" alert, before Electron's ready. The argument-domain default below is
// process-local, so it keeps a failing run going without touching the developer's own Electron.
function launch(userData) {
  const env = { ...process.env, VOICE_HELPER_TEST: "1", VOICE_USER_DATA_DIR: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = start(
    electronPath,
    [
      `--inspect=${ports.inspect}`,
      ".",
      `--remote-debugging-port=${ports.cdp}`,
      "-ApplePersistenceIgnoreState",
      "YES",
    ],
    { cwd: join(repoDir, "apps/desktop"), env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const output = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  return { child, exited, text: () => output.join("") };
}

function reapGroup(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
}

async function quitMain() {
  const targets = await (await fetch(`http://127.0.0.1:${ports.inspect}/json`)).json();
  const inspector = await Page.open(targets[0].webSocketDebuggerUrl);
  try {
    await inspector.evaluate("process.mainModule.require('electron').app.quit(); 'quit called'");
  } finally {
    inspector.close();
  }
}

async function runTrial(mode, trial, userData) {
  const app = launch(userData);
  let hub;
  let stateAtQuit;
  let quitAt;
  try {
    hub = await Page.connect(ports.cdp, "hub.html");
    const snapshots = new Stream();
    await hub.bind("__voiceQuitSmoke", (payload) => snapshots.push(JSON.parse(payload)));
    await hub.evaluate(`
      window.voice.onSnapshot((s) => __voiceQuitSmoke(JSON.stringify(s)));
      window.voice.getSnapshot().then((s) => __voiceQuitSmoke(JSON.stringify(s)));
      true`);
    const snapshot = await snapshots.waitFor(
      (s) => [mode, "ready", "failed"].includes(s.models.cleanup.state),
      { timeoutMs: MODEL_TIMEOUT_MS, label: `cleanup model ${mode}` },
    );
    stateAtQuit = snapshot.models.cleanup.state;
    if (stateAtQuit !== mode) {
      throw new Error(`cleanup model reached ${stateAtQuit} before the trial could quit`);
    }
    hub.close();
    hub = undefined;
    quitAt = performance.now();
    await Promise.race([quitMain(), app.exited]);
  } catch (error) {
    reapGroup(app.child);
    await app.exited;
    return {
      mode,
      trial,
      stateAtQuit,
      harnessError: error instanceof Error ? error.message : String(error),
      ok: false,
      outputTail: tail(app.text()),
    };
  } finally {
    hub?.close();
  }

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), EXIT_TIMEOUT_MS);
  });
  const timedOut = (await Promise.race([app.exited, timeout])) === "timeout";
  clearTimeout(timer);
  const quitToExitMs = Math.round(performance.now() - quitAt);
  if (timedOut) reapGroup(app.child);
  const exit = await app.exited;
  reapGroup(app.child);
  const crashed = app.text().includes(CRASH_SIGNATURE);
  const result = {
    mode,
    trial,
    stateAtQuit,
    code: exit.code,
    signal: exit.signal,
    quitToExitMs,
    timedOut,
    crashed,
  };
  result.ok = !timedOut && !crashed && exit.signal === null && exit.code === 0;
  if (!result.ok) result.outputTail = tail(app.text());
  return result;
}

const tail = (text) => text.trim().split("\n").slice(-40);

async function main() {
  const userData = await prepareUserData("voice-quit-smoke");
  const results = [];
  try {
    for (const mode of modes) {
      for (let trial = 1; trial <= trials; trial += 1) {
        const result = await runTrial(mode, trial, userData);
        results.push(result);
        console.log(JSON.stringify(result));
      }
    }
  } finally {
    await stopChildren();
    rmSync(userData, { recursive: true, force: true });
  }
  const failed = results.filter((result) => !result.ok);
  note(`${results.length - failed.length}/${results.length} trials exited cleanly`);
  if (failed.length > 0) {
    for (const result of failed) {
      const reason =
        result.harnessError ??
        `${result.signal ?? `code ${result.code}`}${result.timedOut ? ", timed out" : ""}${result.crashed ? ", uncaught native exception" : ""}`;
      note(`${result.mode} #${result.trial} failed: ${reason}`);
    }
    process.exitCode = 1;
  }
}

stopChildrenOnSignal();
await main();

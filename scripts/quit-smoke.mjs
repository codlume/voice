#!/usr/bin/env node
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  evaluateInMain,
  launchVoice,
  Page,
  prepareUserData,
  releaseUserData,
  repoDir,
  signalGroup,
  snapshotStream,
  stopChildren,
  stopChildrenOnSignal,
} from "./voice-app.mjs";

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
const MODES = ["ready", "loading", "cleaning", "transcribing"];
const modes = args.mode ? [args.mode] : MODES;
for (const mode of modes) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
}
// Quitting mid-generation must abort it: shutdown has a 3 s bound and logs when it overruns.
const SHUTDOWN_OVERRUN = "quit: shutdown still running";
const CLEANING_START_MS = 400;
const LONG_DICTATION = Array.from(
  { length: 40 },
  (_, i) =>
    `so um item ${i + 1} is that we should probably move the ${["sync", "review", "launch", "retro"][i % 4]} to ${["monday", "tuesday", "thursday", "friday"][i % 4]} and uh let the team know before noon`,
).join(" ");

// The scripted helper owes its transcript for longer than the quit takes to arrive, and a quit
// must still leave that transcript in a history kept on disk.
const owedTranscript = (trial) => `the quit has to keep transcript ${trial}`;
const FAKE_HELPER = join(repoDir, "apps/desktop/src/main/testing/fake-helper.ts");
const helperControl = join(tmpdir(), `voice-quit-smoke-${process.pid}.sock`);
const scriptedHelper = (trial) => ({
  VOICE_HELPER_PATH: FAKE_HELPER,
  VOICE_FAKE_HELPER: JSON.stringify({
    control: helperControl,
    transcript: owedTranscript(trial),
    transcriptMs: 800,
  }),
});

const note = (message) => console.error(`[quit-smoke] ${message}`);

function launch(userData, env) {
  const { child, ports } = launchVoice(userData, { inspect: true, env });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  return { child, ports, exited, text: () => output.join("") };
}

const quitMain = (inspectPort) =>
  evaluateInMain(inspectPort, "process.mainModule.require('electron').app.quit(); 'quit called'");

// Starts a long cleanup and returns before it finishes, so the quit lands mid-generation.
const startCleaning = (inspectPort) =>
  evaluateInMain(
    inspectPort,
    `globalThis.voiceTest.cleanup.clean(${JSON.stringify(LONG_DICTATION)},
      { style: "formal", layout: "general" },
      { budgetMs: 60_000, signal: new AbortController().signal }).catch(() => undefined); 'cleaning'`,
  );

// Holds the scripted key, releases it, and returns while the helper still owes the transcript.
async function startTranscribing(hub, snapshots) {
  await hub.evaluate('window.voice.setHistoryRetention("forever")');
  const helper = connect(helperControl);
  await once(helper, "connect");
  helper.write("down\n");
  await snapshots.waitFor((s) => s.session.kind === "listening", {
    timeoutMs: 5000,
    label: "the session to start listening",
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  helper.write("up\n");
  await snapshots.waitFor((s) => s.session.kind === "processing", {
    timeoutMs: 5000,
    label: "the session to start transcribing",
  });
  helper.destroy();
}

function keptTranscript(userData, trial) {
  try {
    const { entries } = JSON.parse(readFileSync(join(userData, "history.json"), "utf8"));
    return entries.some((entry) => entry.raw === owedTranscript(trial));
  } catch {
    return false;
  }
}

async function runTrial(mode, trial, userData) {
  const transcribing = mode === "transcribing";
  const app = launch(userData, transcribing ? scriptedHelper(trial) : {});
  let hub;
  let stateAtQuit;
  let quitAt;
  try {
    const { DevTools: port, Debugger: inspectPort } = await app.ports;
    hub = await Page.connect(port, "hub.html");
    const snapshots = await snapshotStream(hub);
    const wanted = mode === "cleaning" || transcribing ? "ready" : mode;
    const snapshot = await snapshots.waitFor(
      (s) => [wanted, "ready", "failed"].includes(s.models.cleanup.state),
      { timeoutMs: MODEL_TIMEOUT_MS, label: `cleanup model ${wanted}` },
    );
    stateAtQuit = snapshot.models.cleanup.state;
    if (stateAtQuit !== wanted) {
      throw new Error(`cleanup model reached ${stateAtQuit} before the trial could quit`);
    }
    if (transcribing) await startTranscribing(hub, snapshots);
    hub.close();
    hub = undefined;
    if (mode === "cleaning") {
      await startCleaning(inspectPort);
      await new Promise((resolve) => setTimeout(resolve, CLEANING_START_MS));
    }
    quitAt = performance.now();
    await Promise.race([quitMain(inspectPort), app.exited]);
  } catch (error) {
    signalGroup(app.child.pid, "SIGKILL");
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
  if (timedOut) signalGroup(app.child.pid, "SIGKILL");
  const exit = await app.exited;
  signalGroup(app.child.pid, "SIGKILL");
  const crashed = app.text().includes(CRASH_SIGNATURE);
  const shutdownOverran = app.text().includes(SHUTDOWN_OVERRUN);
  const result = {
    mode,
    trial,
    stateAtQuit,
    code: exit.code,
    signal: exit.signal,
    quitToExitMs,
    timedOut,
    crashed,
    shutdownOverran,
  };
  if (transcribing) result.keptTranscript = keptTranscript(userData, trial);
  result.ok =
    !timedOut &&
    !crashed &&
    !shutdownOverran &&
    exit.signal === null &&
    exit.code === 0 &&
    result.keptTranscript !== false;
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
    await releaseUserData(userData, { remove: true });
  }
  const failed = results.filter((result) => !result.ok);
  note(`${results.length - failed.length}/${results.length} trials exited cleanly`);
  if (failed.length > 0) {
    for (const result of failed) {
      const reason =
        result.harnessError ??
        `${result.signal ?? `code ${result.code}`}${result.timedOut ? ", timed out" : ""}${result.crashed ? ", uncaught native exception" : ""}${result.shutdownOverran ? ", shutdown overran its bound" : ""}`;
      note(`${result.mode} #${result.trial} failed: ${reason}`);
    }
    process.exitCode = 1;
  }
}

stopChildrenOnSignal();
await main();

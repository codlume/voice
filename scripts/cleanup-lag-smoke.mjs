#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  launchVoice,
  Page,
  prepareUserData,
  releaseUserData,
  snapshotStream,
  stopChildren,
  stopChildrenOnSignal,
} from "./voice-app.mjs";

const TICK_MS = 2;
const IDLE_WINDOW_MS = 3000;
const LOAD_TIMEOUT_MS = 120_000;

const { values: args } = parseArgs({
  options: {
    trials: { type: "string", default: "3" },
    "budget-ms": { type: "string", default: "20" },
    json: { type: "string" },
  },
});
const trials = Number(args.trials);
const budgetMs = Number(args["budget-ms"]);
const note = (message) => console.error(`[cleanup-lag-smoke] ${message}`);

const MONITOR = `(() => {
  const lag = { max: 0, stalls: [] };
  let last = performance.now();
  lag.timer = setInterval(() => {
    const now = performance.now();
    const late = now - last - ${TICK_MS};
    if (late > lag.max) lag.max = late;
    if (late > 10) lag.stalls.push(Math.round(late));
    last = now;
  }, ${TICK_MS});
  globalThis.__cleanupLag = lag;
  return true;
})()`;

const READ_AND_RESET = `(() => {
  const lag = globalThis.__cleanupLag;
  const result = { maxMs: Math.round(lag.max), stallsMs: lag.stalls };
  lag.max = 0;
  lag.stalls = [];
  return result;
})()`;

async function inspector(inspectPort) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${inspectPort}/json`)).json();
      return await Page.open(targets[0].webSocketDebuggerUrl);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`no inspector on port ${inspectPort}`);
}

async function runTrial(trial) {
  const userData = await prepareUserData("voice-cleanup-lag-smoke");
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ cleanup: { enabled: false } }));
  let hub;
  let main;
  try {
    const { ports } = launchVoice(userData, { inspect: true });
    const { DevTools: port, Debugger: inspectPort } = await ports;
    hub = await Page.connect(port, "hub.html");
    main = await inspector(inspectPort);
    const snapshots = await snapshotStream(hub);
    await snapshots.waitFor((s) => s.models.cleanup.state === "installed", {
      timeoutMs: LOAD_TIMEOUT_MS,
      label: "cleanup installed but not loaded",
    });
    await main.evaluate(MONITOR);
    await new Promise((resolve) => setTimeout(resolve, IDLE_WINDOW_MS));
    const idle = await main.evaluate(READ_AND_RESET);

    const loadStarted = performance.now();
    await hub.evaluate(`window.voice.updateSettings({ cleanup: { enabled: true } })`);
    await snapshots.waitFor((s) => ["ready", "failed"].includes(s.models.cleanup.state), {
      timeoutMs: LOAD_TIMEOUT_MS,
      label: "cleanup model ready",
    });
    const loadMs = Math.round(performance.now() - loadStarted);
    const state = snapshots.items.at(-1).models.cleanup.state;
    const load = await main.evaluate(READ_AND_RESET);
    if (state !== "ready") throw new Error(`cleanup model ended ${state}`);
    const result = { trial, idle, load, loadMs };
    note(JSON.stringify(result));
    return result;
  } finally {
    hub?.close();
    main?.close();
    await stopChildren();
    await releaseUserData(userData, { remove: true });
  }
}

stopChildrenOnSignal();
const results = [];
try {
  for (let trial = 1; trial <= trials; trial++) results.push(await runTrial(trial));
} finally {
  await stopChildren();
}
const worst = Math.max(...results.map((r) => r.load.maxMs));
const summary = { budgetMs, worstLoadStallMs: worst, results };
if (args.json) writeFileSync(args.json, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
if (worst > budgetMs) {
  note(`FAIL: main stalled ${worst} ms while the cleanup model loaded (budget ${budgetMs} ms)`);
  process.exit(1);
}
note(`PASS: worst main stall ${worst} ms during cleanup load (budget ${budgetMs} ms)`);

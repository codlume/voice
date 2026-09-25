#!/usr/bin/env node
// Idle cost of the built app: launch it like `pnpm e2e` (no microphone), wait for both models
// plus a settle period, then sample RSS and CPU of every process in the app's tree with ps.
import { execFileSync, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { basename, join } from "node:path";

import {
  assert,
  launchVoice,
  Page,
  prepareUserData,
  repoDir,
  stopChildren,
  stopChildrenOnSignal,
} from "./voice-app.mjs";

const port = 9347;
const settleMs = 10_000;
const sampleMs = 20_000;
const intervalMs = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const note = (message) => console.error(`[idle] ${message}`);

function run(command, args) {
  note(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: repoDir, stdio: ["ignore", "ignore", "inherit"] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}

// ps prints cumulative CPU time as [[dd-]hh:]mm:ss.cc.
function seconds(time) {
  const [rest, days = "0"] = time.split("-").toReversed();
  return (
    Number(days) * 86_400 + rest.split(":").reduce((total, part) => total * 60 + Number(part), 0)
  );
}

function label(args) {
  if (args.includes("voice-helper")) return "voice-helper";
  const type = /--type=(\S+)/.exec(args)?.[1];
  if (!type) return basename(args.split(" ")[0]) === "Electron" ? "Electron main" : args;
  const subType = /--utility-sub-type=(\S+)/.exec(args)?.[1];
  return subType ? `${type} (${subType})` : type;
}

function tree(rootPid) {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,time=,args="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => {
      const [, pid, ppid, rss, time, args] = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        rssKb: Number(rss),
        cpuS: seconds(time),
        args,
      };
    });
  const inTree = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (inTree.has(row.ppid) && !inTree.has(row.pid)) {
        inTree.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((row) => inTree.has(row.pid));
}

async function waitForModels() {
  const pill = await Page.connect(port, "pill.html");
  try {
    const deadline = Date.now() + 180_000;
    for (;;) {
      const snapshot = await pill.evaluate("window.voice.getSnapshot()");
      const { models } = snapshot;
      if (models.asr.state === "ready" && models.cleanup.state === "ready") return snapshot;
      assert(Date.now() < deadline, `models not ready after 180 s: ${JSON.stringify(models)}`);
      await sleep(250);
    }
  } finally {
    pill.close();
  }
}

// ps %cpu is a decaying average over up to a minute, so it would still carry model loading.
// CPU% here is the growth in cumulative CPU time across the window.
async function sample(rootPid) {
  const seen = new Map();
  const startedAt = performance.now();
  for (let tick = 0; tick <= sampleMs / intervalMs; tick += 1) {
    await sleep(startedAt + tick * intervalMs - performance.now());
    const at = performance.now();
    for (const row of tree(rootPid)) {
      const entry = seen.get(row.pid) ?? {
        label: label(row.args),
        rss: [],
        first: { at, cpuS: row.cpuS },
      };
      entry.rss.push(row.rssKb);
      entry.last = { at, cpuS: row.cpuS };
      seen.set(row.pid, entry);
    }
  }
  return [...seen].map(([pid, entry]) => {
    const wallS = (entry.last.at - entry.first.at) / 1000;
    return {
      pid,
      process: entry.label,
      samples: entry.rss.length,
      rssMb: entry.rss.reduce((a, b) => a + b, 0) / entry.rss.length / 1024,
      cpuPercent: wallS > 0 ? ((entry.last.cpuS - entry.first.cpuS) / wallS) * 100 : 0,
    };
  });
}

function print(rows) {
  const total = {
    pid: "",
    process: "total",
    samples: "",
    rssMb: rows.reduce((sum, row) => sum + row.rssMb, 0),
    cpuPercent: rows.reduce((sum, row) => sum + row.cpuPercent, 0),
  };
  const lines = [...rows.toSorted((a, b) => b.rssMb - a.rssMb), total].map((row) =>
    [
      String(row.pid).padStart(6),
      row.process.padEnd(40),
      String(row.samples).padStart(7),
      row.rssMb.toFixed(1).padStart(9),
      row.cpuPercent.toFixed(2).padStart(7),
    ].join("  "),
  );
  console.log(
    `${"pid".padStart(6)}  ${"process".padEnd(40)}  samples  ${"RSS MB".padStart(9)}  ${"CPU %".padStart(7)}`,
  );
  for (const line of lines) console.log(line);
}

async function main() {
  run("swift", ["build", "--package-path", join(repoDir, "native/voice-helper")]);
  run("pnpm", ["build"]);
  const userData = await prepareUserData("voice-idle");
  try {
    const { child } = launchVoice(userData, { port });
    const { permissions } = await waitForModels();
    // The hub opens at launch and polls permissions while any is missing.
    note(`models ready, permissions ${JSON.stringify(permissions)}; settling ${settleMs / 1000} s`);
    await sleep(settleMs);
    note(`sampling ${sampleMs / 1000} s`);
    print(await sample(child.pid));
  } finally {
    await stopChildren();
    rmSync(userData, { recursive: true, force: true });
  }
}

stopChildrenOnSignal();
await main();

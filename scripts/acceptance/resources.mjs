// Whole-app resource run (#39): the packaged app on a loopback provider, sampled at 100 ms across
// every process in main's tree, through quiet idle, a full recovery backlog with a five-minute
// capture, Retry, subordinate restarts, and repeated sessions after recovery is cleared.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { fixturePath, loadCatalog, root, work } from "./fixtures.mjs";
import { launch, loopback } from "./session.mjs";
import { sha256 } from "./lib.mjs";

const exec = promisify(execFile);
const sampler = join(work, "bin/footprint");
export const intervalMs = 100;

async function compileSampler() {
  if (!existsSync(sampler)) {
    await mkdir(join(work, "bin"), { recursive: true });
    await exec("swiftc", ["-O", join(root, "scripts/acceptance/footprint.swift"), "-o", sampler]);
  }
}

// Chromium's per-window counters since the session attached. Layout and style recalculation stay
// flat when nothing repaints; running Web Animations reveal a continuous idle animation.
// Performance.enable resets the counters, so each window keeps one session for the whole run.
async function paintProbe(app) {
  const sessions = [];
  for (const page of app.windows()) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    sessions.push({ page, cdp });
  }
  return async () => {
    const windows = [];
    for (const { page, cdp } of sessions) {
      const { metrics } = await cdp.send("Performance.getMetrics");
      const value = (name) => metrics.find((metric) => metric.name === name)?.value ?? 0;
      windows.push({
        url: new URL(page.url()).search || "/",
        visible: await page.evaluate(() => document.visibilityState),
        animations: await page.evaluate(() => document.getAnimations().length),
        layouts: value("LayoutCount"),
        styles: value("RecalcStyleCount"),
        taskMs: value("TaskDuration") * 1000,
      });
    }
    return windows;
  };
}

export async function resources({ directory }) {
  await compileSampler();
  const catalog = await loadCatalog();
  const fixture = (id) => {
    const item = catalog.fixtures.find((entry) => entry.id === id);
    return { ...item, path: fixturePath(item) };
  };
  const short = fixture("request");
  const long = fixture("long_1");
  for (const item of [short, long])
    if (sha256(await readFile(item.path)) !== item.sha256) throw new Error(`${item.id} changed`);

  const server = await loopback();
  const data = await mkdtemp(join(tmpdir(), "voice-acceptance-"));
  const samplesFile = join(directory, "samples.jsonl");
  const events = [];
  let phase = "launch";
  let voice;
  let probe;
  const mark = async (name, detail = {}) => {
    const event = { at: Date.now(), phase: name, ...detail };
    events.push(event);
    phase = name;
    console.log(`[resources] ${name}`);
    await appendFile(join(directory, "events.jsonl"), JSON.stringify(event) + "\n");
  };
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  const recovery = async () => (await voice.status()).session.recovery;
  // One no-target session: without an external target every result is retained for recovery.
  const session = async (item, mode) => {
    server.set(item.spoken, mode);
    await voice.hook("captureSource", item.path);
    await voice.hook("timeline");
    await voice.hook("shortcut", "hold.down");
    await voice.hook("captured", item.seconds * 50);
    await voice.hook("shortcut", "hold.up");
    const settled = await voice.until(
      ({ session }) => ["complete", "failed", "cancelled", "idle"].includes(session.phase),
      (item.seconds <= 30 ? 10_000 : 30_000) + 10_000,
    );
    server.set("", "echo");
    if (!settled) throw new Error(`${item.id} session did not settle`);
    return settled.session;
  };
  try {
    await mark("launch");
    voice = await launch({ provider: server.url, directory: data });
    probe = spawn(sampler, [String(voice.app.process().pid), String(intervalMs)]);
    const lines = createInterface({ input: probe.stdout });
    const writes = [];
    lines.on("line", (line) => {
      writes.push(appendFile(samplesFile, JSON.stringify({ phase, ...JSON.parse(line) }) + "\n"));
    });

    const paint = await paintProbe(voice.app);
    await mark("idle", { paint: await paint() });
    await wait(60_000);
    await mark("idle.end", { paint: await paint() });

    // Four held sessions expire their deadline and keep audio; the five-minute capture fills the
    // fifth entry. Held connections never finalize, so each entry retains its complete source.
    await mark("backlog");
    for (let index = 0; index < 4; index++) await session(short, "hold");
    await mark("five-minute");
    await session(long, "hold");
    await mark("backlog.full", { recovery: (await recovery()).length });

    // Retry the five-minute source with the backlog full. A 1.25x replay cannot fit the 30 s
    // deadline, so the entry stays incomplete; the point here is the memory during the replay.
    await mark("retry");
    server.set(long.spoken);
    await voice.command({ type: "recovery.retry", id: (await recovery()).at(-1).id });
    await voice.until(({ session }) => session.retrying !== null, 5_000);
    await voice.until(({ session }) => session.retrying === null, 60_000);
    server.set("", "echo");
    await mark("retry.end", { recovery: (await recovery()).length });

    // Subordinate failures while the backlog is held: main keeps every entry.
    await mark("worker-restart");
    await voice.hook("killProvider");
    await wait(3_000);
    await voice.hook("killHelper");
    for (let tries = 0; (await voice.hook("helper")).state !== "ready" && tries < 200; tries++)
      await wait(50);
    await wait(3_000);
    await mark("worker-restart.end", {
      recovery: (await recovery()).length,
      helper: (await voice.hook("helper")).state,
    });

    await mark("cleared");
    for (const entry of await recovery())
      await voice.command({ type: "recovery.discard", id: entry.id });
    await wait(10_000);

    await mark("repeated");
    for (let index = 0; index < 20; index++) {
      const result = await session(short, "echo");
      for (const entry of result.recovery)
        await voice.command({ type: "recovery.discard", id: entry.id });
    }
    await mark("idle-after", { paint: await paint() });
    await wait(60_000);
    await mark("idle-after.end", {
      paint: await paint(),
      recovery: (await recovery()).length,
    });
    await Promise.all(writes);
  } finally {
    probe?.kill();
    await voice?.app.close().catch(() => {});
    await server.close();
    await rm(data, { recursive: true, force: true });
  }
  return events;
}

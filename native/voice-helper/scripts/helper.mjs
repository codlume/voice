// Drives a built voice-helper over NDJSON for the smoke scripts and later e2e.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const packageDir = fileURLToPath(new URL("..", import.meta.url));
export const repoDir = join(packageDir, "../..");
export const fixturesDir = join(repoDir, "test-fixtures/audio");

const spikeModel = "/tmp/voice-spike-swift/models/parakeet-tdt-0.6b-v3";

export function helperBinary(name = "voice-helper") {
  if (name === "voice-helper" && process.env.VOICE_HELPER_BIN) return process.env.VOICE_HELPER_BIN;
  return join(packageDir, ".build/debug", name);
}

// A models dir holding parakeet-tdt-0.6b-v3. Defaults to a symlink onto the spike's copy so
// nothing is downloaded.
export function modelsDir() {
  const dir = process.env.VOICE_MODELS_DIR ?? "/tmp/voice-helper-models";
  const model = join(dir, "parakeet-tdt-0.6b-v3");
  if (!existsSync(model) && existsSync(spikeModel)) {
    mkdirSync(dir, { recursive: true });
    symlinkSync(spikeModel, model);
  }
  return dir;
}

export function fixture(name) {
  const path = join(fixturesDir, name);
  if (!existsSync(path)) throw new Error(`missing fixture ${path}; run node scripts/fixtures.mjs`);
  return path;
}

export function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

export class Helper {
  events = [];
  #cursor = 0;
  #waiters = [];

  constructor({ env = {}, args = [] } = {}) {
    this.child = spawn(helperBinary(), ["--models-dir", modelsDir(), ...args], {
      env: { ...process.env, VOICE_HELPER_TEST: "1", ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.exited = new Promise((resolve) =>
      this.child.on("exit", (code, signal) => resolve({ code, signal })),
    );
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error(`helper wrote a non-JSON line: ${line}`);
      }
      if (event.type !== "capture.level") console.error(`<< ${line}`);
      this.events.push(event);
      for (const waiter of this.#waiters.splice(0)) waiter();
    });
  }

  send(command) {
    console.error(`>> ${JSON.stringify(command)}`);
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  // Resolves with the first event after the previous match that satisfies the predicate.
  // Events are consumed in order, so a script reads the protocol as a conversation.
  waitFor(predicate, { timeoutMs = 15_000, label = predicate.toString() } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out after ${timeoutMs} ms waiting for ${label}`)),
        timeoutMs,
      );
      const check = () => {
        for (let i = this.#cursor; i < this.events.length; i += 1) {
          if (!predicate(this.events[i])) continue;
          this.#cursor = i + 1;
          clearTimeout(timer);
          resolve(this.events[i]);
          return;
        }
        this.#waiters.push(check);
      };
      check();
    });
  }

  waitForType(type, { timeoutMs, label = type } = {}) {
    return this.waitFor((event) => event.type === type, { timeoutMs, label });
  }

  eventsSince(index) {
    return this.events.slice(index);
  }

  async close() {
    if (this.child.exitCode !== null) return this.exited;
    this.child.stdin.end();
    const killer = setTimeout(() => this.child.kill("SIGKILL"), 3_000);
    const result = await this.exited;
    clearTimeout(killer);
    return result;
  }
}

export async function withHelper(options, body) {
  const helper = new Helper(options);
  try {
    const ready = await helper.waitForType("ready");
    assert(ready.version === 1, `ready.version is ${ready.version}`);
    return await body(helper);
  } finally {
    await helper.close();
  }
}

// Returns the milliseconds from asr.prepare to asr.status ready.
export async function prepareAsr(helper) {
  const startedAt = performance.now();
  helper.send({ type: "asr.prepare", download: false });
  const status = await helper.waitFor(
    (event) => event.type === "asr.status" && ["ready", "missing", "failed"].includes(event.state),
    { timeoutMs: 60_000, label: "asr.status ready" },
  );
  assert(status.state === "ready", `asr.status is ${status.state}: ${status.message ?? ""}`);
  return performance.now() - startedAt;
}

// Streams a fixture through the test source until it ends, then stops and returns the transcript.
export async function dictateFixture(helper, name, id) {
  helper.send({ type: "test.audioFile", path: fixture(name) });
  const levelsBefore = helper.events.length;
  helper.send({ type: "capture.start", id });
  const started = await helper.waitFor(
    (event) => event.type === "capture.started" && event.id === id,
    {
      label: "capture.started",
    },
  );
  await helper.waitFor(
    (event) => event.type === "log" && event.message === "test.audioFile ended",
    {
      timeoutMs: 60_000,
      label: "test.audioFile ended",
    },
  );
  helper.send({ type: "capture.stop", id });
  const transcript = await helper.waitFor(
    (event) =>
      (event.type === "transcript" || event.type === "transcript.failed") && event.id === id,
    { timeoutMs: 60_000, label: "transcript" },
  );
  assert(
    transcript.type === "transcript",
    `transcript.failed: ${transcript.reason} ${transcript.message}`,
  );
  const levels = helper
    .eventsSince(levelsBefore)
    .filter((event) => event.type === "capture.level" && event.id === id)
    .map((event) => event.level);
  return { started, transcript, levels };
}

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const packageDir = fileURLToPath(new URL("..", import.meta.url));
export const repoDir = join(packageDir, "../..");
export const fixturesDir = join(repoDir, "test-fixtures/audio");

export function helperBinary(name = "voice-helper") {
  if (name === "voice-helper" && process.env.VOICE_HELPER_BIN) return process.env.VOICE_HELPER_BIN;
  return join(packageDir, ".build/debug", name);
}

export function modelsDir() {
  const dir =
    process.env.VOICE_TEST_MODELS_DIR ??
    join(homedir(), "Library/Caches/Voice Development/test-models");
  mkdirSync(dir, { recursive: true });
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

// Call before posting key events or installing a hotkey tap. A dev session or Voice.app runs its
// own helper with real microphone permission, and its tap hears synthetic presses too, so it
// records the room into the test documents. The pattern matches a helper binary but not script
// paths under native/voice-helper/.
export function refuseIfVoiceIsRunning() {
  const pgrep = spawnSync("pgrep", ["-lf", "(^|/)voice-helper( |$)|scripts/dev\\.mjs( |$)"], {
    encoding: "utf8",
  });
  if (pgrep.status === 1) return;
  if (pgrep.status !== 0) throw new Error(`pgrep exited ${pgrep.status}: ${pgrep.stderr}`);
  console.error(pgrep.stdout.trimEnd());
  console.error(
    "refusing to run: another Voice helper is running and would record from the real microphone",
  );
  process.exit(1);
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
      if (!event.type.endsWith(".level")) console.error(`<< ${line}`);
      this.events.push(event);
      for (const waiter of this.#waiters.splice(0)) waiter();
    });
  }

  send(command) {
    console.error(`>> ${JSON.stringify(command)}`);
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

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
    assert(ready.version === 5, `ready.version is ${ready.version}`);
    return await body(helper);
  } finally {
    await helper.close();
  }
}

export async function prepareAsr(helper, { download = false } = {}) {
  const startedAt = performance.now();
  helper.send({ type: "asr.prepare", download });
  const status = await helper.waitFor(
    (event) => event.type === "asr.status" && ["ready", "missing", "failed"].includes(event.state),
    { timeoutMs: download ? 30 * 60_000 : 60_000, label: "asr.status ready" },
  );
  assert(status.state === "ready", `asr.status is ${status.state}: ${status.message ?? ""}`);
  return performance.now() - startedAt;
}

export async function dictateFixture(helper, name, id, language = "en") {
  helper.send({ type: "test.audioFile", path: fixture(name) });
  const levelsBefore = helper.events.length;
  helper.send({ type: "capture.start", microphone: null, id, language, muteWhileDictating: false });
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
  const releasedAt = performance.now();
  helper.send({ type: "capture.stop", id });
  const transcript = await helper.waitFor(
    (event) =>
      (event.type === "transcript" || event.type === "transcript.failed") && event.id === id,
    { timeoutMs: 60_000, label: "transcript" },
  );
  const releaseToTranscriptMs = performance.now() - releasedAt;
  assert(
    transcript.type === "transcript",
    `transcript.failed: ${transcript.reason} ${transcript.message}`,
  );
  const levels = helper
    .eventsSince(levelsBefore)
    .filter((event) => event.type === "capture.level" && event.id === id)
    .map((event) => event.level);
  return { started, transcript, levels, releaseToTranscriptMs };
}

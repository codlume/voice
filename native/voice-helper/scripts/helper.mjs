import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { fixturesDir } from "../../../scripts/fixtures.mjs";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

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

function stateDir() {
  const dir = join(homedir(), "Library/Caches/Voice Development/test-state");
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

export function runningVoiceProcesses() {
  const helpers = new Set();
  const nodes = [];
  for (const [pid, executable] of listProcesses("ucomm")) {
    if (executable === "voice-helper") helpers.add(pid);
    else if (executable === "node") nodes.push(pid);
  }
  const candidates = [...helpers, ...nodes];
  if (candidates.length === 0) return [];
  return listProcesses("args", candidates)
    .filter(([pid, args]) => helpers.has(pid) || /(^|[\s/])scripts\/dev\.mjs(\s|$)/.test(args))
    .map(([pid, args]) => `${pid} ${args}`);
}

function listProcesses(column, pids) {
  const ps = spawnSync(
    "ps",
    ["-ww", "-o", `pid=,${column}=`, ...(pids ? ["-p", pids.join(",")] : ["-ax"])],
    { encoding: "utf8" },
  );
  if (ps.error) throw ps.error;
  // With -p, ps exits 1 without output when every listed process has already exited.
  if (pids && ps.status === 1 && ps.stdout === "" && ps.stderr === "") return [];
  if (ps.status !== 0) throw new Error(`ps exited ${ps.status}: ${ps.stderr}`);
  return ps.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const row = /^\s*(\d+) (.*?)\s*$/.exec(line);
      if (!row) throw new Error(`unexpected ps line: ${line}`);
      return [row[1], row[2]];
    });
}

export const CONTENDING_VOICE_MESSAGE =
  "refusing: another Voice is running, and its hotkey tap would hear the synthetic key press. If it is the user's Voice.app or a pnpm dev session, it would record the real microphone; ask the user to quit it. If it is another session's verify instance, model download, e2e, or smoke run, wait for it to finish.";

export function refuseIfVoiceIsRunning() {
  const running = runningVoiceProcesses();
  if (running.length === 0) return;
  console.error(running.join("\n"));
  console.error(CONTENDING_VOICE_MESSAGE);
  process.exit(1);
}

export class Helper {
  events = [];
  #cursor = 0;
  #waiters = [];

  constructor({ env = {} } = {}) {
    this.child = spawn(helperBinary(), ["--models-dir", modelsDir(), "--state-dir", stateDir()], {
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
  const { HELPER_PROTOCOL_VERSION } = await import("../../../apps/desktop/src/main/protocol.ts");
  const helper = new Helper(options);
  try {
    const ready = await helper.waitForType("ready");
    assert(
      ready.version === HELPER_PROTOCOL_VERSION,
      `ready.version is ${ready.version}, not ${HELPER_PROTOCOL_VERSION}`,
    );
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

export async function dictateFixture(helper, name, id, language = "en", { onStarted } = {}) {
  helper.send({ type: "test.audioFile", path: fixture(name) });
  const levelsBefore = helper.events.length;
  helper.send({
    type: "capture.start",
    microphone: null,
    id,
    language,
    outputVolumeScale: null,
    detectHost: true,
  });
  const started = await helper.waitFor(
    (event) => event.type === "capture.started" && event.id === id,
    {
      label: "capture.started",
    },
  );
  await onStarted?.();
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

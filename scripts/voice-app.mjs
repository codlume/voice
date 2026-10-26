import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { modelsDir, prepareAsr, withHelper } from "../native/voice-helper/scripts/helper.mjs";
import { downloadModel, S1_MINI, S1_MINI_FILE } from "../packages/cleanup/src/download.ts";
import { GEMMA_4_E2B } from "../packages/cleanup/src/transform/model.ts";
import {
  claimScratch,
  releaseScratch,
  scratchPath,
  trackScratchChild,
} from "./smoke-resources.mjs";

export {
  claimScratch,
  processIdentity,
  sameProcess,
  scratchPath,
  worktreeIdentity,
} from "./smoke-resources.mjs";

export { refuseIfVoiceIsRunning } from "../native/voice-helper/scripts/helper.mjs";

export const repoDir = fileURLToPath(new URL("..", import.meta.url));
const desktopDir = join(repoDir, "apps/desktop");
export function electronDependency(directory = desktopDir) {
  let packagePath;
  try {
    packagePath = createRequire(join(directory, "package.json")).resolve("electron/package.json");
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    return { status: "missing: run pnpm install" };
  }
  const dir = dirname(packagePath);
  const installedPath = join(dir, "path.txt");
  if (!existsSync(installedPath))
    return { status: "binary missing: run pnpm --filter @voice/desktop exec install-electron" };
  const path = join(dir, "dist", readFileSync(installedPath, "utf8").trim());
  return existsSync(path)
    ? { status: "installed", path }
    : { status: "binary missing: run pnpm --filter @voice/desktop exec install-electron" };
}

export function electronPath() {
  const dependency = electronDependency();
  if (!dependency.path) throw new Error(`Electron ${dependency.status}`);
  return dependency.path;
}

export function smokeEnvironment(userData, extraEnv = {}) {
  const env = {
    ...process.env,
    ...extraEnv,
    VOICE_HELPER_TEST: "1",
    VOICE_USER_DATA_DIR: userData,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  env.VOICE_HELPER_TEST_AUDIO = "";
  if (extraEnv.VOICE_HELPER_TEST_AUDIO)
    env.VOICE_HELPER_TEST_AUDIO = extraEnv.VOICE_HELPER_TEST_AUDIO;
  return env;
}

export function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

class Stream {
  items = [];
  #cursor = 0;
  #waiters = [];

  push(item) {
    this.items.push(item);
    for (const waiter of this.#waiters.splice(0)) waiter();
  }

  skipToEnd() {
    this.#cursor = this.items.length;
  }

  waitFor(predicate, { timeoutMs, label }) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out after ${timeoutMs} ms waiting for ${label}`)),
        timeoutMs,
      );
      const check = () => {
        for (let i = this.#cursor; i < this.items.length; i += 1) {
          if (!predicate(this.items[i])) continue;
          this.#cursor = i + 1;
          clearTimeout(timer);
          resolve(this.items[i]);
          return;
        }
        this.#waiters.push(check);
      };
      check();
    });
  }
}

// Every snapshot the page reports, starting with the current one.
export async function snapshotStream(page) {
  const snapshots = new Stream();
  await page.bind("__voiceSnapshot", (payload) => snapshots.push(JSON.parse(payload)));
  await page.evaluate(`
    window.voice.onSnapshot((s) => __voiceSnapshot(JSON.stringify(s)));
    window.voice.getSnapshot().then((s) => __voiceSnapshot(JSON.stringify(s)));
    true`);
  return snapshots;
}

export class Page {
  #nextId = 1;
  #pending = new Map();
  #events = new Map();
  #gone = null;

  static async connect(port, urlPart, { timeoutMs = 30_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        const target = targets.find((t) => t.type === "page" && t.url.includes(urlPart));
        if (target) return await Page.open(target.webSocketDebuggerUrl);
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`no ${urlPart} page on CDP port ${port} after ${timeoutMs} ms`);
  }

  static open(url) {
    const ws = new WebSocket(url);
    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(new Page(ws)), { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.closed = new Promise((resolve) => ws.addEventListener("close", resolve, { once: true }));
    // A closed socket never answers, as when the app exits mid-call, so every waiting call fails.
    const drop = (reason) => {
      this.#gone ??= reason;
      for (const { method, reject } of this.#pending.values())
        reject(new Error(`${reason} before ${method} answered`));
      this.#pending.clear();
    };
    ws.addEventListener("close", () => drop("CDP socket closed"), { once: true });
    ws.addEventListener("error", () => drop("CDP socket failed"), { once: true });
    ws.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.id !== undefined) {
        const settle = this.#pending.get(message.id);
        if (!settle) return;
        this.#pending.delete(message.id);
        if (message.error) settle.reject(new Error(message.error.message));
        else settle.resolve(message.result);
      } else {
        this.#events.get(message.method)?.(message.params);
      }
    });
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (this.#gone) throw new Error(`${this.#gone}; cannot call ${method}`);
      const id = this.#nextId++;
      this.#pending.set(id, { method, resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text} ${expression}`);
    return result.value;
  }

  /** One listener per CDP event method. */
  on(method, listener) {
    this.#events.set(method, listener);
  }

  async bind(name, listener) {
    await this.call("Runtime.enable");
    await this.call("Runtime.addBinding", { name });
    this.on("Runtime.bindingCalled", (params) => {
      if (params.name === name) listener(params.payload);
    });
  }

  close() {
    this.ws.close();
  }
}

export async function evaluateInMain(inspectPort, expression) {
  const targets = await (await fetch(`http://127.0.0.1:${inspectPort}/json`)).json();
  const main = await Page.open(targets[0].webSocketDebuggerUrl);
  try {
    return await main.evaluate(expression);
  } finally {
    main.close();
  }
}

// Every process this script starts leads its own group, so shutdown can signal the tools a
// child spawned too and a terminal Ctrl+C reaches only this script.
const children = new Set();

export function start(command, args, options) {
  const child = spawn(command, args, { detached: true, ...options });
  children.add(child);
  child.on("error", () => children.delete(child));
  child.on("exit", () => children.delete(child));
  trackScratchChild(child);
  return child;
}

export async function stopChildren() {
  const exits = [...children].map((child) => new Promise((resolve) => child.once("exit", resolve)));
  for (const child of children) signalGroup(child.pid, "SIGTERM");
  const force = setTimeout(() => {
    for (const child of children) signalGroup(child.pid, "SIGKILL");
  }, 3000);
  await Promise.all(exits);
  clearTimeout(force);
}

export function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {}
}

export const modelFiles = { asr: "parakeet-tdt-0.6b-v3", cleanup: S1_MINI_FILE };
export const optionalModelFiles = { transform: GEMMA_4_E2B.file };

export function linkTestModels(userData, cache) {
  const models = join(userData, "models");
  mkdirSync(models, { recursive: true });
  const link = (file) => symlinkSync(join(cache, file), join(models, file));
  for (const file of Object.values(modelFiles)) link(file);
  for (const file of Object.values(optionalModelFiles)) {
    if (existsSync(join(cache, file))) link(file);
  }
}

// A stable path: CoreML caches compiled models by path, and a fresh path costs ~40 s per run.
export async function prepareUserData(name) {
  const userData = scratchPath(name, repoDir);
  const claim = await claimScratch(userData);
  try {
    const cache = modelsDir();
    console.error(`preparing test models in ${cache}`);
    await Promise.all([
      downloadModel({ dir: cache, source: S1_MINI }),
      withHelper({ env: smokeEnvironment(userData) }, (helper) =>
        prepareAsr(helper, { download: true }),
      ),
    ]);
    claim.reset();
    linkTestModels(userData, cache);
    return userData;
  } catch (error) {
    await claim.release();
    throw error;
  }
}

export const releaseUserData = releaseScratch;

// Chromium and Node bind port 0 to a free port and print the one they got, so instances started
// this way never share a port.
export function announcedPorts(child, servers, { timeoutMs = 30_000 } = {}) {
  const ports = {};
  return new Promise((resolvePorts, reject) => {
    const missing = () => servers.filter((server) => !(server in ports)).join(" and ");
    const timer = setTimeout(
      () => reject(new Error(`no ${missing()} port announced after ${timeoutMs} ms`)),
      timeoutMs,
    );
    const lines = createInterface({ input: child.stderr });
    lines.on("line", (line) => {
      const [, server, port] = /^(\w+) listening on ws:\/\/\S+?:(\d+)\//.exec(line) ?? [];
      if (!servers.includes(server)) return;
      ports[server] = Number(port);
      if (servers.every((name) => name in ports)) {
        clearTimeout(timer);
        resolvePorts(ports);
      }
    });
    lines.on("close", () => {
      clearTimeout(timer);
      reject(new Error(`exited before announcing its ${missing()} port`));
    });
  });
}

// Resolves with the expected text and how long it took to land, or with whatever the target last
// held and landedMs null, so a doubled or truncated insertion stays visible in the evidence.
export async function landedText(read, expected, { timeoutMs = 800 } = {}) {
  const started = performance.now();
  const deadline = started + timeoutMs;
  let text = "";
  const missed = () => ({ text, landedMs: null });
  const poll = async () => {
    while (performance.now() < deadline) {
      text = await read();
      const now = performance.now();
      if (now >= deadline) break;
      if (text === expected) return { text, landedMs: Math.round(now - started) };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return missed();
  };
  let timer;
  try {
    return await Promise.race([
      poll(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(missed()), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// `electron` is the binary to run; tests pass a stand-in so nothing launches the real app.
export function launchVoice(
  userData,
  { inspect = false, env: extraEnv = {}, electron = electronPath() } = {},
) {
  // -ApplePersistenceIgnoreState keeps a modal "restore windows?" alert from blocking a launch
  // after earlier unclean exits.
  const child = start(
    electron,
    [
      ".",
      "--remote-debugging-port=0",
      ...(inspect ? ["--inspect=0"] : []),
      "-ApplePersistenceIgnoreState",
      "YES",
    ],
    {
      cwd: desktopDir,
      env: smokeEnvironment(userData, extraEnv),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const logs = new Stream();
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (line.startsWith("[voice]")) console.error(line);
    logs.push(line);
  });
  createInterface({ input: child.stderr }).on("line", (line) => {
    if (process.env.VOICE_E2E_VERBOSE) console.error(`[voice stderr] ${line}`);
  });
  return {
    child,
    logs,
    ports: announcedPorts(child, inspect ? ["DevTools", "Debugger"] : ["DevTools"]),
  };
}

export function stopChildrenOnSignal() {
  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void stopChildren().finally(() => process.exit(128 + constants.signals[signal]));
    });
  }
}

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { modelsDir, prepareAsr, withHelper } from "../native/voice-helper/scripts/helper.mjs";
import { downloadS1Mini, S1_MINI_FILE } from "../packages/cleanup/src/download.ts";

export const repoDir = fileURLToPath(new URL("..", import.meta.url));
const desktopDir = join(repoDir, "apps/desktop");
export const electronPath = createRequire(join(desktopDir, "package.json"))("electron");

export function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

export class Stream {
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

export class Page {
  #nextId = 1;
  #pending = new Map();
  #bindings = new Map();

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
    ws.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.id !== undefined) {
        const settle = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) settle.reject(new Error(message.error.message));
        else settle.resolve(message.result);
      } else if (message.method === "Runtime.bindingCalled") {
        this.#bindings.get(message.params.name)?.(message.params.payload);
      }
    });
  }

  call(method, params = {}) {
    const id = this.#nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
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

  async bind(name, listener) {
    await this.call("Runtime.enable");
    await this.call("Runtime.addBinding", { name });
    this.#bindings.set(name, listener);
  }

  close() {
    this.ws.close();
  }
}

// Every process this script starts leads its own group, so shutdown can signal the tools a
// child spawned too and a terminal Ctrl+C reaches only this script.
const children = new Set();

export function start(command, args, options) {
  const child = spawn(command, args, { detached: true, ...options });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

export async function stopChildren() {
  const exits = [...children].map((child) => new Promise((resolve) => child.once("exit", resolve)));
  for (const child of children) signalGroup(child, "SIGTERM");
  const force = setTimeout(() => {
    for (const child of children) signalGroup(child, "SIGKILL");
  }, 3000);
  await Promise.all(exits);
  clearTimeout(force);
}

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {}
}

export async function prepareTestModels() {
  const dir = modelsDir();
  console.error(`preparing test models in ${dir}`);
  await Promise.all([
    downloadS1Mini({ dir }),
    withHelper({}, (helper) => prepareAsr(helper, { download: true })),
  ]);
  return dir;
}

// A stable path: CoreML caches compiled models by path, and a fresh path costs ~40 s per run.
export async function prepareUserData(name) {
  const cache = await prepareTestModels();
  const userData = join(tmpdir(), name);
  rmSync(userData, { recursive: true, force: true });
  const models = join(userData, "models");
  mkdirSync(models, { recursive: true });
  for (const model of ["parakeet-tdt-0.6b-v3", S1_MINI_FILE]) {
    symlinkSync(join(cache, model), join(models, model));
  }
  return userData;
}

export function launchVoice(userData, { port, env: extraEnv = {} }) {
  const env = {
    ...process.env,
    VOICE_HELPER_TEST: "1",
    VOICE_USER_DATA_DIR: userData,
    ...extraEnv,
  };
  // Set when this script itself runs under Electron, for example inside an Electron-based IDE.
  delete env.ELECTRON_RUN_AS_NODE;
  const child = start(electronPath, [".", `--remote-debugging-port=${port}`], {
    cwd: desktopDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = new Stream();
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (line.startsWith("[voice]")) console.error(line);
    logs.push(line);
  });
  createInterface({ input: child.stderr }).on("line", (line) => {
    if (process.env.VOICE_E2E_VERBOSE) console.error(`[voice stderr] ${line}`);
  });
  return { child, logs };
}

export function stopChildrenOnSignal() {
  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void stopChildren().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
    });
  }
}

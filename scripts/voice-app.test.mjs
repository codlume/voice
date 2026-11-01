import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { HELPER_PROTOCOL_VERSION } from "../apps/desktop/src/main/protocol.ts";
import { withHelper } from "../native/voice-helper/scripts/helper.mjs";
import {
  announcedPorts,
  claimScratch,
  electronDependency,
  landedText,
  launchVoice,
  linkTestModels,
  modelFiles,
  optionalModelFiles,
  Page,
  processIdentity,
  smokeEnvironment,
  smokePackagedApp,
  stopChildren,
} from "./voice-app.mjs";

const child = () => ({ stderr: new PassThrough() });

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("dependency inspection never executes Electron's installer or entry point", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "voice-electron-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "package.json"), "{}");
  assert.match(electronDependency(dir).status, /missing: run pnpm install/);
  const electron = join(dir, "node_modules/electron");
  mkdirSync(electron, { recursive: true });
  writeFileSync(
    join(electron, "package.json"),
    JSON.stringify({ name: "electron", main: "index.js" }),
  );
  const marker = join(dir, "executed");
  writeFileSync(
    join(electron, "index.js"),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected'); throw Error('must not run');`,
  );
  assert.match(
    electronDependency(dir).status,
    /binary missing: run pnpm --filter @voice\/desktop exec install-electron/,
  );
  mkdirSync(join(electron, "dist"));
  writeFileSync(join(electron, "path.txt"), "Electron");
  assert.match(electronDependency(dir).status, /binary missing/);
  const binary = join(electron, "dist/Electron");
  writeFileSync(binary, "synthetic binary");
  assert.deepEqual(electronDependency(dir), { status: "installed", path: realpathSync(binary) });
  assert.equal(existsSync(marker), false);
});

test("smoke environment clears an inherited fixture path and Electron's node mode", (t) => {
  const previous = { ...process.env };
  Object.assign(process.env, {
    ELECTRON_RUN_AS_NODE: "1",
    VOICE_HELPER_TEST_AUDIO: "/private.wav",
  });
  t.after(() => {
    process.env = previous;
  });
  const env = smokeEnvironment("/scratch", { VOICE_HELPER_TEST: "0" });
  assert.equal("ELECTRON_RUN_AS_NODE" in env, false);
  assert.equal(env.VOICE_HELPER_TEST_AUDIO, "");
  assert.equal(env.VOICE_HELPER_TEST, "1");
  assert.equal(env.VOICE_USER_DATA_DIR, "/scratch");
  assert.equal(
    smokeEnvironment("/scratch", { VOICE_HELPER_TEST_AUDIO: "/synthetic.wav" })
      .VOICE_HELPER_TEST_AUDIO,
    "/synthetic.wav",
  );
});

test("the launcher runs Electron in the smoke environment and tracks it for the scratch claim", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "voice-launch-test-"));
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  // A stand-in Electron that reports what it was started with, then waits to be stopped.
  const electron = join(dir, "electron");
  writeFileSync(
    electron,
    `#!${process.execPath}
console.log(JSON.stringify({ args: process.argv.slice(2), env: process.env }));
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  Object.assign(process.env, {
    ELECTRON_RUN_AS_NODE: "1",
    VOICE_HELPER_TEST_AUDIO: "/private.wav",
  });
  const userData = join(dir, "user-data");
  const claim = await claimScratch(userData);
  claim.reset();
  try {
    const capture = join(userData, "capture.wav");
    const launched = launchVoice(userData, {
      inspect: true,
      env: { VOICE_HELPER_TEST_AUDIO: capture },
      electron,
    });
    launched.ports.catch(() => {});
    const started = JSON.parse(
      await launched.logs.waitFor((line) => line.startsWith("{"), {
        timeoutMs: 5000,
        label: "report",
      }),
    );
    assert.deepEqual(started.args, [
      ".",
      "--remote-debugging-port=0",
      "--inspect=0",
      "-ApplePersistenceIgnoreState",
      "YES",
    ]);
    assert.equal(started.env.VOICE_HELPER_TEST, "1");
    assert.equal(started.env.VOICE_USER_DATA_DIR, userData);
    assert.equal(started.env.VOICE_HELPER_TEST_AUDIO, capture);
    assert.equal("ELECTRON_RUN_AS_NODE" in started.env, false);
    const record = JSON.parse(readFileSync(`${userData}.owner.json`, "utf8"));
    assert.deepEqual(record.processes, [
      { pid: launched.child.pid, identity: processIdentity(launched.child.pid) },
    ]);
  } finally {
    await stopChildren();
    await claim.release({ remove: true });
  }
});

test("the required test models are linked always and the optional ones only when cached", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "voice-link-models-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = join(dir, "cache");
  mkdirSync(cache);
  for (const file of Object.values(modelFiles)) writeFileSync(join(cache, file), "model");

  linkTestModels(join(dir, "without"), cache);
  assert.deepEqual(linkedModels(join(dir, "without")), {
    asr: true,
    cleanup: true,
    transform: false,
    speakers: false,
  });

  for (const file of Object.values(optionalModelFiles)) writeFileSync(join(cache, file), "model");
  linkTestModels(join(dir, "with"), cache);
  assert.deepEqual(linkedModels(join(dir, "with")), {
    asr: true,
    cleanup: true,
    transform: true,
    speakers: true,
  });
});

const linkedModels = (userData) =>
  Object.fromEntries(
    Object.entries({ ...modelFiles, ...optionalModelFiles }).map(([id, file]) => [
      id,
      existsSync(join(userData, "models", file)),
    ]),
  );

test("preparation helpers cannot restore an inherited fixture path", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "voice-helper-environment-test-"));
  const binary = join(dir, "helper.mjs");
  const names = ["VOICE_HELPER_TEST_AUDIO"];
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(
    binary,
    `#!/usr/bin/env node
console.log(JSON.stringify({ type: "ready", version: ${HELPER_PROTOCOL_VERSION} }));
console.log(JSON.stringify({ type: "log", env: Object.fromEntries(${JSON.stringify(names)}.map(name => [name, process.env[name]])) }));
process.stdin.resume();
`,
    { mode: 0o755 },
  );
  Object.assign(process.env, {
    VOICE_HELPER_BIN: binary,
    VOICE_TEST_MODELS_DIR: join(dir, "models"),
    ...Object.fromEntries(names.map((name) => [name, "1"])),
  });
  await withHelper({ env: smokeEnvironment(join(dir, "user-data")) }, async (helper) => {
    const event = await helper.waitForType("log");
    for (const name of names) assert.ok(!event.env[name], `${name} reached the helper`);
  });
});

test(
  "calls waiting on a closed CDP socket fail instead of hanging",
  { timeout: 5000 },
  async (t) => {
    const server = createServer();
    server.on("upgrade", (request, socket) => {
      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      // The first request ends the connection unanswered, as when the app exits mid-call.
      socket.once("data", () => socket.destroy());
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const page = await Page.open(`ws://127.0.0.1:${server.address().port}`);
    await assert.rejects(
      page.call("Runtime.evaluate", { expression: "1" }),
      /CDP socket (closed|failed) before Runtime\.evaluate answered/,
    );
    await page.closed;
    await assert.rejects(page.call("Runtime.enable"), /cannot call Runtime\.enable/);
  },
);

test("reads the ports Chromium and Node announce, in either order", async () => {
  const electron = child();
  const ports = announcedPorts(electron, ["DevTools", "Debugger"]);
  electron.stderr.write("[1234:ERROR:gpu_init.cc] unrelated\n");
  electron.stderr.write("Debugger listening on ws://127.0.0.1:49209/ba26db94\n");
  electron.stderr.write("DevTools listening on ws://127.0.0.1:49210/devtools/browser/91fb\n");
  assert.deepEqual(await ports, { DevTools: 49210, Debugger: 49209 });
});

test("concurrent inspectors announce distinct OS-assigned ports", async (t) => {
  const inspectors = Array.from({ length: 2 }, () => {
    const inspector = spawn(process.execPath, ["--inspect=0", "-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    const exited = once(inspector, "exit");
    t.after(async () => {
      inspector.stdin.end();
      await exited;
    });
    return inspector;
  });
  const ports = await Promise.all(
    inspectors.map((inspector) => announcedPorts(inspector, ["Debugger"])),
  );
  assert.notEqual(ports[0].Debugger, ports[1].Debugger);
  for (const { Debugger: port } of ports) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    assert.equal(targets[0].type, "node");
  }
});

test("fails when the process ends before announcing every port", async () => {
  const electron = child();
  const ports = announcedPorts(electron, ["DevTools", "Debugger"]);
  electron.stderr.write("DevTools listening on ws://127.0.0.1:49210/devtools/browser/91fb\n");
  electron.stderr.end();
  await assert.rejects(ports, /exited before announcing its Debugger port/);
});

test("fails when no port is announced in time", async () => {
  const ports = announcedPorts(child(), ["DevTools"], { timeoutMs: 20 });
  await assert.rejects(ports, /no DevTools port announced after 20 ms/);
});

test("reads the target until the expected text lands", async () => {
  const reads = ["", "", "Hi Anna."];
  const landed = await landedText(() => reads.shift() ?? "Hi Anna.", "Hi Anna.");
  assert.equal(landed.text, "Hi Anna.");
  assert.ok(landed.landedMs >= 0, `landedMs ${landed.landedMs}`);
});

test("reports what the target holds when the expected text never lands", async () => {
  assert.deepEqual(await landedText(() => "Hi Anna.Hi Anna.", "Hi Anna.", { timeoutMs: 30 }), {
    text: "Hi Anna.Hi Anna.",
    landedMs: null,
  });
  assert.deepEqual(await landedText(() => "", "Hi Anna.", { timeoutMs: 30 }), {
    text: "",
    landedMs: null,
  });
});

test("times out independently of a slow read and does not read again", async () => {
  let finishRead;
  let reads = 0;
  const pending = new Promise((resolve) => {
    finishRead = resolve;
  });
  const result = await landedText(
    () => {
      reads += 1;
      return pending;
    },
    "Hi Anna.",
    {
      timeoutMs: 30,
    },
  );
  assert.deepEqual(result, { text: "", landedMs: null });
  finishRead("Hi Anna.");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
});

test("a terminal hangup stops the children a script started", async (t) => {
  const parent = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { start, stopChildrenOnSignal } from ${JSON.stringify(import.meta.resolve("./voice-app.mjs"))};
stopChildrenOnSignal();
console.log(start("sleep", ["300"], { stdio: "ignore" }).pid);
setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const childPid = Number(String(await once(parent.stdout, "data")).trim());
  t.after(() => {
    for (const pid of [childPid, parent.pid]) if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  assert.equal(alive(childPid), true);
  parent.kill("SIGHUP");
  const [code, signal] = await once(parent, "exit");
  assert.equal(alive(childPid), false, "the child outlived the hangup");
  assert.deepEqual({ code, signal }, { code: 129, signal: null });
});

function standInApp(t, body) {
  const dir = mkdtempSync(join(tmpdir(), "voice-smoke-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binary = join(dir, "Voice.app/Contents/MacOS/Voice");
  mkdirSync(join(dir, "Voice.app/Contents/MacOS"), { recursive: true });
  writeFileSync(
    binary,
    `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(join(dir, "pid"))}, String(process.pid));
const userData = process.argv.find((a) => a.startsWith("--user-data-dir=")).replace("--user-data-dir=", "");
${body}
`,
    { mode: 0o755 },
  );
  return { app: join(dir, "Voice.app"), pid: () => Number(readFileSync(join(dir, "pid"), "utf8")) };
}

test("the packaged-app smoke waits for the helper ready line, then stops the app", async (t) => {
  const { app, pid } = standInApp(
    t,
    `console.log("[voice] userData " + userData);
console.log("[voice] helper ready (protocol v9)");
setInterval(() => {}, 1000);`,
  );
  await smokePackagedApp(app, { timeoutMs: 5000 });
  assert.equal(alive(pid()), false);
});

test("a packaged app that exits before ready fails the smoke with its output", async (t) => {
  const { app } = standInApp(
    t,
    `console.error("Error: Cannot find module 'does-not-exist'");
process.exit(1);`,
  );
  await assert.rejects(smokePackagedApp(app, { timeoutMs: 5000 }), (error) => {
    assert.match(error.message, /exited \(code 1, signal null\) before its helper was ready/);
    assert.match(error.message, /Cannot find module 'does-not-exist'/);
    return true;
  });
});

test("a packaged app that never reports ready fails the smoke after the timeout", async (t) => {
  const { app, pid } = standInApp(
    t,
    `console.log("[voice] userData " + userData);
setInterval(() => {}, 1000);`,
  );
  await assert.rejects(
    smokePackagedApp(app, { timeoutMs: 500 }),
    /no helper ready line after 500 ms/,
  );
  assert.equal(alive(pid()), false);
});

test("a packaged app that keeps its userData outside the smoke directory fails the smoke", async (t) => {
  const { app, pid } = standInApp(
    t,
    `console.log("[voice] userData /Users/someone/Library/Application Support/Voice");
console.log("[voice] helper ready (protocol v9)");
setInterval(() => {}, 1000);`,
  );
  await assert.rejects(
    smokePackagedApp(app, { timeoutMs: 5000 }),
    /kept its userData at \/Users\/someone\/Library\/Application Support\/Voice/,
  );
  assert.equal(alive(pid()), false);
});

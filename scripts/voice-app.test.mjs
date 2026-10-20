import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { withHelper } from "../native/voice-helper/scripts/helper.mjs";
import { announcedPorts, electronDependency, landedText, smokeEnvironment } from "./voice-app.mjs";

const child = () => ({ stderr: new PassThrough() });

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

test("smoke environment clears inherited fixture and hardware opt-ins", (t) => {
  const inherited = {
    ELECTRON_RUN_AS_NODE: "1",
    VOICE_HELPER_ALLOW_MICROPHONE: "1",
    VOICE_HELPER_TEST_AUDIO: "/private.wav",
    VOICE_MICROPHONE_SMOKE: "1",
    VOICE_MICROPHONE_CAPTURE_SMOKE: "1",
  };
  const previous = { ...process.env };
  Object.assign(process.env, inherited);
  t.after(() => {
    process.env = previous;
  });
  const env = smokeEnvironment("/scratch", {
    VOICE_HELPER_ALLOW_MICROPHONE: "1",
    VOICE_HELPER_TEST: "0",
  });
  assert.equal("ELECTRON_RUN_AS_NODE" in env, false);
  for (const name of Object.keys(inherited).filter((name) => name !== "ELECTRON_RUN_AS_NODE"))
    assert.equal(env[name], "", name);
  assert.equal(env.VOICE_HELPER_TEST, "1");
  assert.equal(env.VOICE_USER_DATA_DIR, "/scratch");
  assert.equal(
    smokeEnvironment("/scratch", { VOICE_HELPER_TEST_AUDIO: "/synthetic.wav" })
      .VOICE_HELPER_TEST_AUDIO,
    "/synthetic.wav",
  );
});

test("preparation helpers cannot restore inherited capture opt-ins", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "voice-helper-environment-test-"));
  const binary = join(dir, "helper.mjs");
  const names = [
    "VOICE_HELPER_ALLOW_MICROPHONE",
    "VOICE_HELPER_TEST_AUDIO",
    "VOICE_MICROPHONE_SMOKE",
    "VOICE_MICROPHONE_CAPTURE_SMOKE",
  ];
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(
    binary,
    `#!/usr/bin/env node
console.log(JSON.stringify({ type: "ready", version: 12 }));
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
    const child = spawn(process.execPath, ["--inspect=0", "-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    const exited = once(child, "exit");
    t.after(async () => {
      child.stdin.end();
      await exited;
    });
    return child;
  });
  const ports = await Promise.all(inspectors.map((child) => announcedPorts(child, ["Debugger"])));
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

test("does not expose unexpected target text when the paste never lands", async () => {
  assert.deepEqual(
    await landedText(() => "Synthetic restored clipboard.", "Hi Anna.", { timeoutMs: 30 }),
    {
      text: "",
      landedMs: null,
    },
  );
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

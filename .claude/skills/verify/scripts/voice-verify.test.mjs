import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseDictateFlags } from "./dictate-flags.mjs";
import { keyEvents } from "./key-events.mjs";
import { processIdentity, scratchPath } from "../../../../scripts/voice-app.mjs";

const script = fileURLToPath(new URL("voice-verify.mjs", import.meta.url));
const worktree = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

test("cold doctor and help run without dependencies and leave caches untouched", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "voice-verify-cold-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = join(dir, "checkout");
  const paths = [
    ".claude/skills/verify/scripts/voice-verify.mjs",
    ".claude/skills/verify/scripts/dictate-flags.mjs",
    ".claude/skills/verify/scripts/key-events.mjs",
    ".claude/skills/verify/scripts/scenarios.mjs",
    "scripts/voice-app.mjs",
    "scripts/smoke-resources.mjs",
    "scripts/fixtures.mjs",
    "native/voice-helper/scripts/helper.mjs",
    "packages/cleanup/src/download.ts",
    "packages/cleanup/src/apache-2.0.ts",
  ];
  for (const path of paths) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    copyFileSync(join(worktree, path), join(checkout, path));
  }
  for (const path of ["apps/desktop/src", "native/voice-helper/Sources"])
    mkdirSync(join(checkout, path), { recursive: true });
  writeFileSync(join(checkout, "package.json"), '{"type":"module"}');
  const cache = join(dir, "models-must-not-be-created");
  const temp = join(dir, "temp");
  mkdirSync(temp);
  const run = (command) =>
    spawnSync(process.execPath, [join(checkout, paths[0]), command], {
      env: { ...process.env, TMPDIR: temp, VOICE_TEST_MODELS_DIR: cache },
      encoding: "utf8",
      timeout: 5000,
    });
  const doctor = run("doctor");
  assert.equal(doctor.status, 0, doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  assert.deepEqual(report.dependencies, {
    workspace: "missing: run pnpm install",
    electron: "missing: run pnpm install",
  });
  assert.equal(report.instance, "none");
  assert.equal(existsSync(cache), false);
  assert.deepEqual(readdirSync(temp), []);
  const help = run("help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /read-only health report/);
  const launch = run("launch");
  assert.notEqual(launch.status, 0);
  assert.match(launch.stderr, /Electron missing: run pnpm install/);
  const scenario = spawnSync(
    process.execPath,
    [join(checkout, paths[0]), "scenario", "short-dictation"],
    {
      env: { ...process.env, TMPDIR: temp, VOICE_TEST_MODELS_DIR: cache },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(scenario.status, 1, scenario.stderr);
  const blocked = JSON.parse(scenario.stdout);
  assert.equal(blocked.status, "BLOCKED");
  assert.ok(blocked.prerequisites.builds.length > 0);
  assert.ok(blocked.prerequisites.models.length > 0);
  assert.deepEqual(readdirSync(temp), []);
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "voice-verify-stop-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const userData = scratchPath("voice-verify", worktree, dir);
  const statePath = `${userData}.json`;
  mkdirSync(userData);
  return {
    userData,
    statePath,
    write: (state) => writeFileSync(statePath, JSON.stringify({ worktree, userData, ...state })),
    stop: () =>
      new Promise((resolveStop) => {
        execFile(
          process.execPath,
          [script, "stop"],
          {
            env: { ...process.env, TMPDIR: dir },
            encoding: "utf8",
            timeout: 15_000,
          },
          (error, stdout, stderr) => resolveStop({ status: error?.code ?? 0, stdout, stderr }),
        );
      }),
  };
}

test("scenario teardown refuses another run's recorded instance", async (t) => {
  const f = fixture(t);
  const proc = await child(t, process.execPath, [
    "-e",
    'process.stdout.write("ready"); process.stdin.resume()',
  ]);
  const state = { ownerPid: proc.pid, scenarioOwner: "interactive-owner" };
  f.write(state);
  const original = readFileSync(f.statePath, "utf8");
  const result = spawnSync(process.execPath, [script, "stop", "--scenario-owner=scenario-owner"], {
    env: { ...process.env, TMPDIR: dirname(f.statePath) },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /refusing to stop an instance owned by another run/);
  assert.equal(readFileSync(f.statePath, "utf8"), original);
  assert.doesNotThrow(() => process.kill(proc.pid, 0));
});

async function child(t, command, args) {
  const proc = spawn(command, args, { detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(proc, "exit");
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) process.kill(-proc.pid, "SIGTERM");
    await exited;
  });
  await once(proc.stdout, "data");
  return proc;
}

test("stop leaves an unrelated live process with a stale recorded identity alone", async (t) => {
  const f = fixture(t);
  const proc = await child(t, process.execPath, [
    "-e",
    'process.stdout.write("ready"); process.stdin.resume()',
  ]);
  f.write({
    ownerPid: proc.pid,
    ownerIdentity: "old process",
    electronPid: proc.pid,
    electronIdentity: "old Electron",
    runId: "synthetic",
  });
  const result = await f.stop();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotThrow(() => process.kill(proc.pid, 0));
  assert.equal(existsSync(f.statePath), false);
  assert.equal(existsSync(f.userData), false);
});

test("a contending stop cannot enter cleanup and the OS releases a dead holder's lock", async (t) => {
  const f = fixture(t);
  f.write({ ownerPid: 99999999, runId: "synthetic" });
  const holder = await child(t, "/usr/bin/lockf", [
    "-k",
    "-t",
    "0",
    `${f.statePath}.stop-lock`,
    process.execPath,
    "-e",
    'process.stdout.write("locked"); process.stdin.resume()',
  ]);
  const blocked = await f.stop();
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.match(blocked.stderr, /stop already in progress/);
  assert.equal(existsSync(f.statePath), true);
  assert.equal(existsSync(f.userData), true);
  const ended = once(holder, "exit");
  process.kill(-holder.pid, "SIGTERM");
  await ended;
  const recovered = await f.stop();
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(existsSync(f.statePath), false);
});

test("stop accepts an exited owner before its parent reaps it", { timeout: 3000 }, async (t) => {
  const f = fixture(t);
  const proc = await child(t, process.execPath, [
    "-e",
    'process.stdout.write("ready"); process.stdin.resume()',
  ]);
  f.write({ ownerPid: proc.pid, ownerIdentity: processIdentity(proc.pid) });
  const result = spawnSync(process.execPath, [script, "stop"], {
    env: { ...process.env, TMPDIR: dirname(f.statePath) },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(f.statePath), false);
  assert.equal(existsSync(f.userData), false);
  await once(proc, "exit");
});

test("dictate --app parses a bundle id with an optional host, and the defaults stay", () => {
  assert.deepEqual(parseDictateFlags([]), { end: "audio", mode: "hold", app: null });
  assert.deepEqual(parseDictateFlags(["--end=escape", "--key=toggle"]), {
    end: "escape",
    mode: "toggle",
    app: null,
  });
  assert.deepEqual(parseDictateFlags(["--app=com.apple.MobileSMS"]).app, {
    bundleId: "com.apple.MobileSMS",
    host: null,
  });
  assert.deepEqual(parseDictateFlags(["--app=com.google.Chrome@mail.google.com"]).app, {
    bundleId: "com.google.Chrome",
    host: "mail.google.com",
  });
  for (const bad of [
    "--app=",
    "--app=@mail.google.com",
    "--app=com.google.Chrome@",
    "--app=a@b@c",
  ]) {
    assert.throws(() => parseDictateFlags([bad]), /--app must be/, bad);
  }
  assert.throws(() => parseDictateFlags(["--end=later"]), /--end must be/);
  assert.throws(() => parseDictateFlags(["--key=tap"]), /--key must be/);
});

test("key presses each modifier around the key and releases them in reverse", () => {
  const press = (type, code, key, windowsVirtualKeyCode, modifiers) => ({
    type,
    code,
    key,
    windowsVirtualKeyCode,
    modifiers,
  });
  assert.deepEqual(keyEvents("Digit1", ["option"]), [
    press("rawKeyDown", "AltLeft", "Alt", 18, 1),
    press("rawKeyDown", "Digit1", "1", 49, 1),
    press("keyUp", "Digit1", "1", 49, 1),
    press("keyUp", "AltLeft", "Alt", 18, 0),
  ]);
  assert.deepEqual(keyEvents("KeyA", ["command", "shift"]), [
    press("rawKeyDown", "ShiftLeft", "Shift", 16, 8),
    press("rawKeyDown", "MetaLeft", "Meta", 91, 12),
    press("rawKeyDown", "KeyA", "A", 65, 12),
    press("keyUp", "KeyA", "A", 65, 12),
    press("keyUp", "MetaLeft", "Meta", 91, 8),
    press("keyUp", "ShiftLeft", "Shift", 16, 0),
  ]);
  assert.deepEqual(keyEvents("Enter"), [
    press("rawKeyDown", "Enter", "Enter", 13, 0),
    press("keyUp", "Enter", "Enter", 13, 0),
  ]);
  assert.equal(keyEvents("KeyK", ["control"])[1].key, "k");
  assert.throws(() => keyEvents("Digit1", ["alt"]), /unknown modifier alt/);
  assert.throws(() => keyEvents("Numpad1"), /unknown key code Numpad1/);
});

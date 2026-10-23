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

import { runInNewContext } from "node:vm";

import { clickExpression } from "./click-expression.mjs";
import { parseDictateFlags } from "./dictate-flags.mjs";
import { keyEvents } from "./key-events.mjs";
import {
  expectedLanding,
  freshLast,
  optionShortcutTransform,
  parseTransformFlags,
  pillSummary,
  resolveOutcome,
  shouldEscape,
  transformLogLine,
} from "./transforms.mjs";
import { processIdentity, scratchPath } from "../../../../scripts/voice-app.mjs";

const script = fileURLToPath(new URL("voice-verify.mjs", import.meta.url));
const worktree = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

test("cold doctor and help run without dependencies and leave caches untouched", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "voice-verify-cold-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = join(dir, "checkout");
  const sources = (directory) =>
    readdirSync(join(worktree, directory))
      .filter((file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs"))
      .map((file) => `${directory}/${file}`);
  const paths = [
    ...sources(".claude/skills/verify/scripts"),
    ...sources("scripts"),
    "native/voice-helper/scripts/helper.mjs",
    "packages/cleanup/src/download.ts",
    "packages/cleanup/src/apache-2.0.ts",
    "packages/cleanup/src/transform/model.ts",
  ];
  for (const path of paths) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    copyFileSync(join(worktree, path), join(checkout, path));
  }
  const verify = join(checkout, ".claude/skills/verify/scripts/voice-verify.mjs");
  for (const path of ["apps/desktop/src", "native/voice-helper/Sources"])
    mkdirSync(join(checkout, path), { recursive: true });
  writeFileSync(join(checkout, "package.json"), '{"type":"module"}');
  const cache = join(dir, "models-must-not-be-created");
  const temp = join(dir, "temp");
  mkdirSync(temp);
  const run = (command) =>
    spawnSync(process.execPath, [verify, command], {
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
  assert.deepEqual(report.testModels, { asr: "will download", cleanup: "will download" });
  assert.deepEqual(report.optionalTestModels, { transform: "missing" });
  assert.equal(existsSync(cache), false);
  assert.deepEqual(readdirSync(temp), []);
  const help = run("help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /read-only health report/);
  const launch = run("launch");
  assert.notEqual(launch.status, 0);
  assert.match(launch.stderr, /Electron missing: run pnpm install/);
  const scenario = spawnSync(process.execPath, [verify, "scenario", "short-dictation"], {
    env: { ...process.env, TMPDIR: temp, VOICE_TEST_MODELS_DIR: cache },
    encoding: "utf8",
    timeout: 5000,
  });
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

function runClick(target, elements) {
  const calls = [];
  const stub = ({ name, disabled = false }) => ({
    textContent: name,
    labels: null,
    disabled,
    getAttribute: () => null,
    getClientRects: () => [{}],
    focus: () => calls.push(`focus ${name}`),
    click: () => calls.push(`click ${name}`),
  });
  const document = {
    querySelectorAll: () => elements.map(stub),
    getElementById: () => null,
  };
  const result = runInNewContext(clickExpression(target), { document });
  return { result: JSON.parse(JSON.stringify(result)), calls };
}

test("click focuses the element before it clicks, so a picker records the keys that follow", () => {
  assert.deepEqual(runClick("Shortcut", [{ name: "Shortcut" }, { name: "Save changes" }]), {
    result: { clicked: "Shortcut" },
    calls: ["focus Shortcut", "click Shortcut"],
  });
  assert.deepEqual(runClick("css:main button", [{ name: "Only" }]), {
    result: { clicked: "Only" },
    calls: ["focus Only", "click Only"],
  });
});

test("click touches nothing when the match is missing, ambiguous, or disabled", () => {
  assert.deepEqual(runClick("Shortcut", [{ name: "Other" }]), { result: false, calls: [] });
  assert.deepEqual(runClick("css:button", [{ name: "A" }, { name: "B" }]), {
    result: { ambiguous: ["A", "B"] },
    calls: [],
  });
  assert.deepEqual(runClick("Shortcut", [{ name: "Shortcut", disabled: true }]), {
    result: false,
    calls: [],
  });
});

test("transform flags default to Option+1 in the scratch textarea and reject typos", () => {
  assert.deepEqual(parseTransformFlags([]), { target: "electron", keycode: 18, escape: false });
  assert.deepEqual(parseTransformFlags(["--target=textedit", "--shortcut=19", "--escape"]), {
    target: "textedit",
    keycode: 19,
    escape: true,
  });
  assert.throws(() => parseTransformFlags(["--target=safari"]), /--target must be/);
  for (const bad of ["--shortcut=", "--shortcut=128", "--shortcut=1.5", "--shortcut=a"])
    assert.throws(() => parseTransformFlags([bad]), /--shortcut must be/, bad);
  assert.throws(() => parseTransformFlags(["--escape=yes"]), /unknown flag --escape=yes/);
  assert.throws(() => parseTransformFlags(["--target", "textedit"]), /--target must be/);
});

test("transform finds the item on exactly Option plus the key", () => {
  const item = (name, keycode, modifiers) => ({ name, shortcut: { keycode, modifiers } });
  const transforms = {
    enabled: true,
    items: [
      item("Shifted", 18, ["option", "shift"]),
      item("Polish", 18, ["option"]),
      item("Prompt Engineer", 19, ["option"]),
      { name: "Unbound", shortcut: null },
    ],
  };
  assert.equal(optionShortcutTransform(transforms, 18).name, "Polish");
  assert.equal(optionShortcutTransform(transforms, 19).name, "Prompt Engineer");
  assert.throws(
    () => optionShortcutTransform(transforms, 20),
    /no transform is on Option with keycode 20; Option shortcuts: \[\{"name":"Polish","keycode":18\},\{"name":"Prompt Engineer","keycode":19\}\]/,
  );
  assert.throws(
    () => optionShortcutTransform({ ...transforms, enabled: false }, 18),
    /Transforms are off/,
  );
});

test("the transform log line yields its outcome and timings without the log prefix", () => {
  const log = [
    "[voice] session 1a2b3c4d outcome=inserted startMs=1 asrMs=80",
    "[voice] transform 9f8e7d6c outcome=notInserted via=copy readMs=48 generateMs=3120 insertMs=7 words=40",
    "[voice] transform 00000000 outcome=inserted via=accessibility readMs=1 generateMs=1 insertMs=1 words=1",
  ].join("\n");
  assert.deepEqual(transformLogLine(log), {
    line: "transform 9f8e7d6c outcome=notInserted via=copy readMs=48 generateMs=3120 insertMs=7 words=40",
    fields: {
      id: "9f8e7d6c",
      outcome: "notInserted",
      via: "copy",
      readMs: 48,
      generateMs: 3120,
      insertMs: 7,
      words: 40,
    },
  });
  assert.equal(transformLogLine("[voice] transform model loaded in 2100 ms\n"), null);
  assert.equal(transformLogLine(""), null);
});

test("a missed transformDone is recovered from main's log line, and no outcome stays null", () => {
  const blocked = { kind: "notInserted", reason: "focusChanged" };
  const done = { session: { kind: "transformDone", outcome: blocked } };
  const idle = { session: { kind: "idle" } };
  const logged = { line: "transform 9f8e7d6c outcome=inserted", fields: { outcome: "inserted" } };
  assert.deepEqual(resolveOutcome(done, logged), { outcome: blocked, outcomeFrom: "pill" });
  assert.deepEqual(resolveOutcome(idle, logged), {
    outcome: { kind: "inserted" },
    outcomeFrom: "log",
  });
  assert.deepEqual(resolveOutcome(idle, null), { outcome: null, outcomeFrom: null });
});

test("a Last transform from before the press is dropped, and the landing is awaited only for an insert", () => {
  const last = { finishedAt: 1000, after: "Polished." };
  assert.equal(freshLast(last, 1000), last);
  assert.equal(freshLast(last, 1001), null);
  assert.equal(freshLast(null, 0), null);
  assert.equal(expectedLanding({ kind: "inserted" }, last), "Polished.");
  assert.equal(expectedLanding({ kind: "inserted" }, null), null);
  assert.equal(expectedLanding({ kind: "notInserted" }, last), null);
  assert.equal(expectedLanding(null, last), null);
});

test("escape is posted only while the run is still transforming", () => {
  assert.equal(shouldEscape(true, "transforming"), true);
  assert.equal(shouldEscape(true, "transformDone"), false);
  assert.equal(shouldEscape(true, "idle"), false);
  assert.equal(shouldEscape(false, "transforming"), false);
});

test("the pill summary reports whether the run loaded the model and reached transformDone", () => {
  const snapshot = (kind, loading) => ({ session: { kind, loading } });
  const done = snapshot("transformDone");
  assert.deepEqual(
    pillSummary([snapshot("transforming", true), snapshot("transforming", false), done], done),
    { sawTransforming: true, sawLoading: true, sawTransformDone: true },
  );
  assert.deepEqual(pillSummary([snapshot("transforming", false)], snapshot("idle")), {
    sawTransforming: true,
    sawLoading: false,
    sawTransformDone: false,
  });
});

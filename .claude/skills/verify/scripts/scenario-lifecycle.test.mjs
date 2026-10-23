import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  processIdentity,
  sameProcess,
  scratchPath,
  signalGroup,
} from "../../../../scripts/voice-app.mjs";

const scripts = fileURLToPath(new URL(".", import.meta.url));
const runtime = new URL("../../../../scripts/voice-app.mjs", import.meta.url).href;

// A TextEdit that answers the AppleScript the targets send: the document it was last asked to
// open, a pid for every process, and a log of each script it ran.
const OSASCRIPT_STUB = `
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.VOICE_TEST_DIR;
const script = process.argv[3] ?? "";
fs.writeFileSync(path.join(dir, "focus"), "called");
fs.appendFileSync(path.join(dir, "osascript.log"), script + "\\n");
const targetFile = path.join(dir, "target.json");
const pid = fs.existsSync(targetFile) ? JSON.parse(fs.readFileSync(targetFile, "utf8")).pid : 4242;
const documentFile = path.join(dir, "document.json");
const opened = /open POSIX file ("[^"]*")/.exec(script);
if (opened) {
  const file = JSON.parse(opened[1]);
  fs.writeFileSync(
    documentFile,
    JSON.stringify({ name: path.basename(file), text: fs.readFileSync(file, "utf8") }),
  );
}
const document = fs.existsSync(documentFile)
  ? JSON.parse(fs.readFileSync(documentFile, "utf8"))
  : { name: "", text: "" };
const answers = [
  ["is running", "false"],
  ["unix id", String(pid)],
  ["get name of document", document.name],
  ["get text of", document.text],
  ["count documents", "0"],
];
process.stdout.write(answers.find(([needle]) => script.includes(needle))?.[1] ?? "");
`;

function checkout(t, mode) {
  const dir = mkdtempSync(join(tmpdir(), "voice-scenario-test-"));
  const repo = join(dir, "checkout");
  const temp = join(dir, "temp");
  const trace = join(dir, "trace.json");
  mkdirSync(temp);
  const put = (path, text) => {
    const file = join(repo, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  put("package.json", '{"type":"module"}');
  for (const path of [
    "node_modules",
    "apps/desktop/src",
    "packages/cleanup/src",
    "native/voice-helper/Sources",
  ])
    mkdirSync(join(repo, path), { recursive: true });
  for (const path of [
    "apps/desktop/dist-electron/main.cjs",
    "native/voice-helper/.build/debug/voice-helper",
    "native/voice-helper/.build/debug/fnpost",
    "test-fixtures/audio/short.wav",
  ])
    put(path, "synthetic test placeholder");
  for (const name of readdirSync(scripts).filter((file) => /^(?!.*\.test\.).*\.mjs$/.test(file)))
    put(`.claude/skills/verify/scripts/${name}`, readFileSync(join(scripts, name), "utf8"));
  put(
    "scripts/targets.mjs",
    readFileSync(new URL("../../../../scripts/targets.mjs", import.meta.url), "utf8"),
  );
  put(
    "native/voice-helper/scripts/helper.mjs",
    `export const CONTENDING_VOICE_MESSAGE = "synthetic contending Voice";
    export const runningVoiceProcesses = () =>
    process.argv[2] === "dictate" && !${JSON.stringify(["dictate-signal", "replace-history", "replace-snapshot", "replace-key", "crash"])}.includes(${JSON.stringify(mode)})
      ? ["synthetic contending helper"] : [];`,
  );
  put("bin/osascript", `#!${process.execPath}\nimport("./osascript-impl.cjs");\n`);
  put("bin/osascript-impl.cjs", OSASCRIPT_STUB);
  put("bin/pbpaste", `#!${process.execPath}\nprocess.stdout.write("synthetic clipboard");\n`);
  put(
    "native/voice-helper/.build/debug/fnpost",
    `#!${process.execPath}\nimport("node:fs").then(fs => fs.writeFileSync(${JSON.stringify(join(dir, "key"))}, "called"));\n`,
  );
  for (const path of ["bin/osascript", "bin/pbpaste", "native/voice-helper/.build/debug/fnpost"])
    chmodSync(join(repo, path), 0o755);
  put("scripts/e2e-target/main.cjs", "setInterval(() => {}, 1000);");
  put(
    "scripts/fixtures.mjs",
    `export const fixturesDir = ${JSON.stringify(join(repo, "test-fixtures/audio"))};`,
  );
  put(
    "scripts/voice-app.mjs",
    `
    export * from ${JSON.stringify(runtime)};
    import { claimScratch, processIdentity, scratchPath, start as startOwned } from ${JSON.stringify(runtime)};
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    import { setTimeout as sleep } from "node:timers/promises";
    import { createContext, runInContext } from "node:vm";
    export const repoDir = ${JSON.stringify(repo)};
    export const modelFiles = {};
    export const electronDependency = () => ({ status: "installed" });
    export const electronPath = () => process.execPath;
    export async function prepareUserData(name) {
      if (${JSON.stringify(mode)} === "preparing") return new Promise(() => {});
      const claim = await claimScratch(scratchPath(name, repoDir));
      claim.reset();
      return claim.userData;
    }
    const snapshot = {
      settings: { hotkey: "fn", toggleHotkey: "rightOption", cleanup: { enabled: true } },
      permissions: { accessibility: ${JSON.stringify(mode === "permission" ? "denied" : "granted")} },
      models: { asr: { state: "ready" }, cleanup: { state: ${JSON.stringify(mode === "model" ? "failed" : "ready")} } },
    };
    export const snapshotStream = async () => ({
      items: [snapshot], waitFor: async () => snapshot, skipToEnd() {},
    });
    async function pause() {
      writeFileSync(${JSON.stringify(join(dir, "paused"))}, "waiting");
      while (!existsSync(${JSON.stringify(join(dir, "resume"))})) await sleep(10);
    }
    export const Page = {
      async connect() {
        if (${JSON.stringify(mode)} === "launch") throw new Error("synthetic page failure");
        return {
          close() {},
          async evaluate(expression) {
            if (expression === "window.voice.getSnapshot()") {
              if (${JSON.stringify(mode)} === "replace-snapshot" && process.argv[2] === "dictate")
                await pause();
              return snapshot;
            }
            if (expression.startsWith("window.voice.getHistory()")) {
              if (${JSON.stringify(mode)} === "replace-history" && process.argv[2] === "scenario")
                await pause();
              return process.argv[2] === "dictate" ? null : [];
            }
            if (expression.includes('document.getElementById("field").focus()')) return true;
            if (expression.includes('document.getElementById("field")')) return "synthetic field";
            if (expression.includes("!document.hasFocus()")) return true;
            if (expression.startsWith("window.voice.updateSettings")) {
              writeFileSync(${JSON.stringify(join(dir, "setup"))}, "ready");
              if (${JSON.stringify(mode)} === "signal") return new Promise(() => {});
              if (["cleanup", "dictate-signal", "replace-history", "replace-snapshot",
                   "replace-key", "crash"].includes(${JSON.stringify(mode)})) return;
              throw new Error("synthetic settings failure");
            }
            throw new Error("unexpected evaluation " + expression);
          },
        };
      },
    };
    const original = async () => ({ text: "synthetic cleanup" });
    const context = createContext({ voiceTest: {
      cleanup: { clean: original },
      setTarget: () => writeFileSync(${JSON.stringify(join(dir, "set-target"))}, "called"),
    } });
    export async function evaluateInMain(_port, expression) {
      const result = await runInContext(expression, context);
      if (expression.includes(".setTarget(") && ${JSON.stringify(mode)} === "replace-key")
        await pause();
      if (expression.includes(".setTarget(") && ${JSON.stringify(mode)} === "crash") {
        // The app dies mid-session, before the key press that would start dictation.
        const { childPid } = JSON.parse(readFileSync(${JSON.stringify(trace)}, "utf8"));
        process.kill(childPid, "SIGKILL");
        while (processIdentity(childPid)) await sleep(10);
      }
      return result;
    }
    export function start(command, args, options) {
      const child = startOwned(command, args, options);
      if (args[0]?.includes("e2e-target"))
        writeFileSync(${JSON.stringify(join(dir, "target.json"))}, JSON.stringify({
          pid: child.pid, identity: processIdentity(child.pid),
        }));
      return child;
    }
    export function announcedPorts() {
      return ["replace-key", "crash"].includes(${JSON.stringify(mode)})
        ? Promise.resolve({ DevTools: 3 }) : new Promise(() => {});
    }
    export function launchVoice(userData) {
      writeFileSync(userData + "/main.log", "");
      const child = start(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      writeFileSync(${JSON.stringify(trace)}, JSON.stringify({
        ownerPid: process.pid, ownerIdentity: processIdentity(process.pid),
        childPid: child.pid, childIdentity: processIdentity(child.pid),
      }));
      return { child, ports: Promise.resolve({ DevTools: 1, Debugger: 2 }) };
    }
  `,
  );
  const userData = scratchPath("voice-verify", repo, temp);
  t.after(() => {
    if (existsSync(trace)) {
      const state = JSON.parse(readFileSync(trace, "utf8"));
      for (const [pid, identity] of [
        [state.ownerPid, state.ownerIdentity],
        [state.childPid, state.childIdentity],
      ]) {
        if (sameProcess(pid, identity)) signalGroup(pid, "SIGKILL");
      }
    }
    const target = join(dir, "target.json");
    if (existsSync(target)) {
      const { pid, identity } = JSON.parse(readFileSync(target, "utf8"));
      if (sameProcess(pid, identity)) signalGroup(pid, "SIGKILL");
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    trace,
    userData,
    script: join(repo, ".claude/skills/verify/scripts/voice-verify.mjs"),
    temp,
    env: {
      ...process.env,
      TMPDIR: temp,
      VOICE_TEST_DIR: dir,
      PATH: `${join(repo, "bin")}:${process.env.PATH}`,
    },
  };
}

async function waitForFile(path) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path) && Date.now() < deadline) await sleep(20);
  assert.ok(existsSync(path), `never reached ${path}`);
}

function runScenario(t, f, name) {
  const proc = execFile(process.execPath, [f.script, "scenario", name], {
    env: f.env,
    timeout: 12_000,
    killSignal: "SIGKILL",
  });
  const result = new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => {
      stdout += data;
    });
    proc.stderr.on("data", (data) => {
      stderr += data;
    });
    proc.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  t.after(() => {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  });
  return { proc, result };
}

function assertTeardown(f) {
  for (const path of [f.userData, `${f.userData}.json`, `${f.userData}.owner.json`])
    assert.equal(existsSync(path), false, `retained ${path}`);
  const { ownerPid, childPid } = JSON.parse(readFileSync(f.trace, "utf8"));
  assert.equal(processIdentity(ownerPid), null);
  assert.equal(processIdentity(childPid), null);
}

for (const mode of ["launch", "settings", "permission", "model", "cleanup"]) {
  test(
    `scenario tears down its recorded processes after ${mode} failure`,
    { timeout: 20_000 },
    async (t) => {
      const f = checkout(t, mode);
      const result = await new Promise((resolve) => {
        execFile(
          process.execPath,
          [f.script, "scenario", mode === "cleanup" ? "cleanup-failure" : "short-dictation"],
          {
            env: f.env,
            timeout: 15_000,
          },
          (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
        );
      });
      assert.equal(result.code, 1, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(
        report.status,
        ["permission", "model", "cleanup"].includes(mode) ? "BLOCKED" : "FAIL",
      );
      assert.equal(existsSync(`${f.userData}.json`), false, result.stderr);
      assert.equal(existsSync(f.userData), false, result.stderr);
      assert.equal(existsSync(`${f.userData}.owner.json`), false, result.stderr);
      const { ownerPid, childPid } = JSON.parse(readFileSync(f.trace, "utf8"));
      assert.equal(processIdentity(ownerPid), null);
      assert.equal(processIdentity(childPid), null);
      if (mode === "cleanup") {
        assert.deepEqual(report.prerequisites.desktop, ["synthetic contending helper"]);
        assert.deepEqual(report.sessions, []);
        assert.deepEqual(JSON.parse(readFileSync(report.evidence, "utf8")), report);
      }
    },
  );
}

test(
  "an instance that exits mid-session fails the scenario instead of blocking it",
  { timeout: 20_000 },
  async (t) => {
    const f = checkout(t, "crash");
    const result = await runScenario(t, f, "short-dictation").result;
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "FAIL", result.stderr);
    assert.match(report.error, /Voice instance exited/);
    assert.equal(existsSync(join(f.dir, "key")), false, "posted a key to a dead instance");
    assertTeardown(f);
    assert.deepEqual(JSON.parse(readFileSync(report.evidence, "utf8")), report);
  },
);

for (const { mode, scenario } of ["replace-history", "replace-snapshot", "replace-key"].flatMap(
  (mode) => ["short-dictation", "cleanup-failure"].map((scenario) => ({ mode, scenario })),
)) {
  test(
    `${scenario} leaves a replacement verifier alone after ${mode}`,
    { timeout: 20_000 },
    async (t) => {
      const f = checkout(t, mode);
      const run = runScenario(t, f, scenario);
      await waitForFile(join(f.dir, "paused"));
      const stopped = await new Promise((resolve) => {
        execFile(process.execPath, [f.script, "_stop"], { env: f.env }, (error, stdout, stderr) =>
          resolve({ error, stdout, stderr }),
        );
      });
      assert.ifError(stopped.error);
      const replacement = spawn(
        process.execPath,
        [f.script, "launch", "--scenario-owner=replacement"],
        {
          env: f.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      t.after(() => {
        if (replacement.exitCode === null) replacement.kill("SIGKILL");
      });
      const [ready] = await once(replacement.stdout, "data");
      assert.equal(JSON.parse(ready).ready, true);
      const statePath = `${f.userData}.json`;
      const replacementState = readFileSync(statePath, "utf8");
      writeFileSync(join(f.userData, "capture.wav"), "synthetic replacement capture");
      writeFileSync(join(f.dir, "resume"), "continue");
      const result = await run.result;
      assert.equal(existsSync(join(f.dir, "key")), false, "posted a key after replacement");
      assert.equal(result.signal, null, `dictation drove the replacement: ${result.stderr}`);
      assert.equal(result.code, 1, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, "BLOCKED");
      assert.ok(report.prerequisites.instance.length > 0);
      assert.equal(readFileSync(statePath, "utf8"), replacementState);
      const { ownerPid, childPid } = JSON.parse(readFileSync(f.trace, "utf8"));
      assert.ok(processIdentity(ownerPid));
      assert.ok(processIdentity(childPid));
      assert.equal(existsSync(join(f.dir, "set-target")), mode === "replace-key");
      if (mode === "replace-key") {
        const target = JSON.parse(readFileSync(join(f.dir, "target.json"), "utf8"));
        assert.equal(processIdentity(target.pid), null);
        assert.equal(existsSync(join(f.dir, "focus")), true);
      } else {
        assert.equal(existsSync(join(f.dir, "target.json")), false);
        assert.equal(existsSync(join(f.dir, "focus")), false);
      }
      assert.equal(
        readFileSync(join(f.userData, "capture.wav"), "utf8"),
        "synthetic replacement capture",
      );
      assert.deepEqual(JSON.parse(readFileSync(report.evidence, "utf8")), report);
    },
  );
}

test(
  "a scenario leaves a pre-existing interactive verifier alone",
  { timeout: 5000 },
  async (t) => {
    const f = checkout(t, "settings");
    const interactive = spawn(
      process.execPath,
      ["-e", 'process.stdout.write("ready"); process.stdin.resume()'],
      {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    await once(interactive.stdout, "data");
    const identity = processIdentity(interactive.pid);
    t.after(() => {
      if (sameProcess(interactive.pid, identity)) signalGroup(interactive.pid, "SIGTERM");
    });
    mkdirSync(f.userData);
    const state = JSON.stringify({
      ownerPid: interactive.pid,
      ownerIdentity: identity,
      userData: f.userData,
    });
    writeFileSync(`${f.userData}.json`, state);
    writeFileSync(join(f.userData, "interactive-data"), "keep");
    const result = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [f.script, "scenario", "short-dictation"],
        { env: f.env },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
      );
    });
    assert.equal(result.code, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "BLOCKED");
    assert.equal(report.prerequisites.instance.length, 1);
    assert.equal(readFileSync(`${f.userData}.json`, "utf8"), state);
    assert.equal(readFileSync(join(f.userData, "interactive-data"), "utf8"), "keep");
    assert.equal(sameProcess(interactive.pid, identity), true);
    assert.equal(existsSync(f.trace), false);
  },
);

test(
  "interrupting a dictated session stops its scratch target before scenario teardown",
  { timeout: 20_000 },
  async (t) => {
    const f = checkout(t, "dictate-signal");
    const proc = spawn(process.execPath, [f.script, "scenario", "short-dictation"], {
      env: f.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(proc, "exit");
    let stderr = "";
    proc.stderr.on("data", (data) => {
      stderr += data;
    });
    proc.stdout.resume();
    t.after(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    });
    const targetTrace = join(f.dir, "target.json");
    const deadline = Date.now() + 10_000;
    while (!existsSync(targetTrace) && Date.now() < deadline) await sleep(20);
    assert.ok(existsSync(targetTrace), stderr);
    const target = JSON.parse(readFileSync(targetTrace, "utf8"));
    proc.kill("SIGTERM");
    const [code] = await exited;
    assert.equal(code, 1, stderr);
    assert.equal(processIdentity(target.pid), null);
    const { ownerPid, childPid } = JSON.parse(readFileSync(f.trace, "utf8"));
    assert.equal(processIdentity(ownerPid), null);
    assert.equal(processIdentity(childPid), null);
    assert.equal(existsSync(`${f.userData}.json`), false);
    assert.equal(existsSync(f.userData), false);
  },
);

test(
  "an interrupted scenario tears down while setup is still pending",
  { timeout: 20_000 },
  async (t) => {
    const f = checkout(t, "signal");
    const proc = spawn(process.execPath, [f.script, "scenario", "short-dictation"], {
      env: f.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(proc, "exit");
    let stderr = "";
    proc.stderr.on("data", (data) => {
      stderr += data;
    });
    proc.stdout.resume();
    t.after(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    });
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(f.dir, "setup")) && Date.now() < deadline) await sleep(20);
    assert.ok(existsSync(join(f.dir, "setup")), stderr);
    const { ownerPid, childPid } = JSON.parse(readFileSync(f.trace, "utf8"));
    proc.kill("SIGTERM");
    const [code] = await exited;
    assert.equal(code, 1, stderr);
    assert.equal(existsSync(`${f.userData}.json`), false, stderr);
    assert.equal(existsSync(f.userData), false, stderr);
    assert.equal(processIdentity(ownerPid), null);
    assert.equal(processIdentity(childPid), null);
  },
);

test(
  "repeated signals during teardown do not leave the instance running",
  { timeout: 20_000 },
  async (t) => {
    const f = checkout(t, "signal");
    const proc = spawn(process.execPath, [f.script, "scenario", "short-dictation"], {
      env: f.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(proc, "exit");
    let stderr = "";
    proc.stderr.on("data", (data) => {
      stderr += data;
    });
    proc.stdout.resume();
    t.after(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    });
    await waitForFile(join(f.dir, "setup"));
    const { ownerPid, ownerIdentity } = JSON.parse(readFileSync(f.trace, "utf8"));
    proc.kill("SIGTERM");
    // Teardown is under way once the launcher is gone; a user mashing Ctrl+C keeps signalling.
    while (sameProcess(ownerPid, ownerIdentity)) await sleep(10);
    const nag = () => {
      try {
        process.kill(proc.pid, "SIGINT");
      } catch {}
    };
    nag();
    const nagging = setInterval(nag, 20);
    const [code, signal] = await exited;
    clearInterval(nagging);
    assert.equal(signal, null, stderr);
    assert.equal(code, 1, stderr);
    assert.match(stderr, /SIGINT ignored/);
    assertTeardown(f);
  },
);

test(
  "an interrupted launch cleans its claim before any app process exists",
  { timeout: 20_000 },
  async (t) => {
    const f = checkout(t, "preparing");
    const proc = spawn(process.execPath, [f.script, "scenario", "short-dictation"], {
      env: f.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(proc, "exit");
    proc.stdout.resume();
    proc.stderr.resume();
    t.after(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    });
    const deadline = Date.now() + 10_000;
    while (!existsSync(`${f.userData}.json`) && Date.now() < deadline) await sleep(20);
    assert.ok(existsSync(`${f.userData}.json`));
    const { ownerPid, ownerIdentity } = JSON.parse(readFileSync(`${f.userData}.json`, "utf8"));
    t.after(() => {
      if (sameProcess(ownerPid, ownerIdentity)) signalGroup(ownerPid, "SIGKILL");
    });
    proc.kill("SIGTERM");
    const [code] = await exited;
    assert.equal(code, 1);
    assert.equal(existsSync(`${f.userData}.json`), false);
    assert.equal(existsSync(f.userData), false);
    assert.equal(existsSync(f.trace), false);
    assert.equal(processIdentity(ownerPid), null);
  },
);

#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { modelsDir } from "../../../../native/voice-helper/scripts/helper.mjs";
import {
  electronPath,
  modelFiles,
  Page,
  prepareUserData,
  snapshotStream,
  start,
  stopChildren,
} from "../../../../scripts/voice-app.mjs";

const repoDir = fileURLToPath(new URL("../../../../", import.meta.url));
const desktopDir = join(repoDir, "apps/desktop");
const helperDir = join(repoDir, "native/voice-helper");
const fixturesDir = join(repoDir, "test-fixtures/audio");
const statePath = join(tmpdir(), "voice-verify.json");
const evidenceRoot = join(tmpdir(), "voice-verify-evidence");
const ports = { voice: 9355, target: 9356 };

const [command = "help", ...args] = process.argv.slice(2);
const show = (value) => JSON.stringify(value);
const out = (value) =>
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
const fail = (message) => {
  console.error(`voice-verify: ${message}`);
  process.exit(1);
};

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {}
}

function requireInstance() {
  const state = readState();
  if (!state || !alive(state.electronPid)) {
    fail("no running verify instance; start one with `voice-verify.mjs launch`");
  }
  return state;
}

async function connect(which) {
  const state = requireInstance();
  return Page.connect(state.port, `${which}.html`, { timeoutMs: 5000 });
}

function evidenceDir() {
  const dir = join(evidenceRoot, requireInstance().runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function otherVoiceProcesses(ownUserData) {
  const pgrep = spawnSync("pgrep", ["-lf", "(^|/)voice-helper( |$)|scripts/dev\\.mjs( |$)"], {
    encoding: "utf8",
  });
  if (pgrep.status === 1) return [];
  return pgrep.stdout
    .trim()
    .split("\n")
    .filter((line) => !ownUserData || !line.includes(ownUserData));
}

const ACCESSIBLE_NAME = `(el) => {
  const ids = el.getAttribute("aria-labelledby");
  const text = el.getAttribute("aria-label")
    ?? (ids && ids.split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" "))
    ?? (el.labels?.[0]?.textContent)
    ?? el.textContent;
  return (text ?? "").replace(/\\s+/g, " ").trim();
}`;
const CANDIDATES =
  'button, a, [role="switch"], [role="radio"], [role="option"], [role="combobox"], [role="menuitem"]';
const visible = "(el) => el.getClientRects().length > 0";

function findExpression(target) {
  if (target.startsWith("css:")) {
    return `[...document.querySelectorAll(${show(target.slice(4))})].filter(${visible})`;
  }
  return `[...document.querySelectorAll(${show(CANDIDATES)})].filter(${visible}).filter((el) => (${ACCESSIBLE_NAME})(el) === ${show(target)})`;
}

async function waitOn(page, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(`Promise.resolve(${expression}).catch(() => false)`);
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${expression} (last ${show(last)})`);
}

const newest = (dir) => {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.parentPath.includes("node_modules")) continue;
    latest = Math.max(latest, statSync(join(entry.parentPath, entry.name)).mtimeMs);
  }
  return latest;
};
const mtime = (path) => (existsSync(path) ? statSync(path).mtimeMs : 0);
const osascript = (script) =>
  execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();

const commands = {
  async doctor() {
    const state = readState();
    const instance = state && alive(state.electronPid) ? state : null;
    let cdp = null;
    if (instance) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${instance.port}/json`)).json();
        cdp = targets.filter((t) => t.type === "page").map((t) => t.url.split("/").at(-1));
      } catch (error) {
        cdp = `unreachable: ${error.message}`;
      }
    }
    const appBuilt = mtime(join(desktopDir, "dist-electron/main.cjs"));
    const appSource = Math.max(
      newest(join(desktopDir, "src")),
      newest(join(repoDir, "packages/cleanup/src")),
    );
    const helperBuilt = mtime(join(helperDir, ".build/debug/voice-helper"));
    const helperSource = newest(join(helperDir, "Sources"));
    const cache = modelsDir();
    const report = {
      node: process.version,
      app: !appBuilt
        ? "not built: run pnpm build"
        : appBuilt < appSource
          ? "stale: run pnpm build"
          : "built",
      helper: !helperBuilt
        ? "not built: run swift build --package-path native/voice-helper"
        : helperBuilt < helperSource
          ? "stale: run swift build --package-path native/voice-helper"
          : "built",
      fnpost: existsSync(join(helperDir, ".build/debug/fnpost")) ? "built" : "missing",
      fixtures: existsSync(join(fixturesDir, "short.wav"))
        ? "present"
        : "missing: run node scripts/fixtures.mjs",
      testModels: Object.fromEntries(
        Object.entries(modelFiles).map(([id, file]) => [
          id,
          existsSync(join(cache, file)) ? "cached" : "will download",
        ]),
      ),
      instance: instance
        ? { ...instance, cdpPages: cdp }
        : state
          ? `stale state file for dead pid ${state.electronPid}; run voice-verify.mjs stop`
          : "none",
      otherVoiceProcesses: otherVoiceProcesses(instance?.userData),
    };
    if (instance && Array.isArray(cdp)) {
      const hub = await connect("hub");
      const s = await hub.evaluate("window.voice.getSnapshot()");
      hub.close();
      report.snapshot = { session: s.session, permissions: s.permissions, models: s.models };
    }
    out(report);
  },

  async launch() {
    const existing = readState();
    if (existing && alive(existing.electronPid))
      fail(`instance already running: ${show(existing)}`);
    try {
      await fetch(`http://127.0.0.1:${ports.voice}/json/version`);
      fail(`port ${ports.voice} is already answering; something else owns it`);
    } catch {}
    if (!existsSync(join(desktopDir, "dist-electron/main.cjs")))
      fail("app not built: run pnpm build");

    const userData = await prepareUserData("voice-verify");
    const fakeMicrophonePath = join(userData, "capture.wav");
    const logPath = join(userData, "main.log");
    const env = {
      ...process.env,
      VOICE_HELPER_TEST: "1",
      VOICE_USER_DATA_DIR: userData,
      VOICE_HELPER_TEST_AUDIO: fakeMicrophonePath,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    // -ApplePersistenceIgnoreState keeps a modal "restore windows?" alert from blocking a launch
    // after earlier unclean exits.
    const child = start(
      electronPath,
      [".", `--remote-debugging-port=${ports.voice}`, "-ApplePersistenceIgnoreState", "YES"],
      { cwd: desktopDir, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (chunk) => appendFileSync(logPath, chunk));
    child.stderr.on("data", (chunk) => appendFileSync(join(userData, "stderr.log"), chunk));

    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const state = {
      ownerPid: process.pid,
      electronPid: child.pid,
      port: ports.voice,
      userData,
      fakeMicrophonePath,
      logPath,
      runId,
      evidence: join(evidenceRoot, runId),
    };
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    let stopping = false;
    const shutdown = async (code) => {
      if (stopping) return;
      stopping = true;
      await stopChildren();
      rmSync(statePath, { force: true });
      rmSync(userData, { recursive: true, force: true });
      process.exit(code);
    };
    process.on("SIGINT", () => void shutdown(130));
    process.on("SIGTERM", () => void shutdown(0));
    child.on("exit", (code, signal) => {
      if (stopping) return;
      console.error(`voice-verify: Voice exited (code ${code}, signal ${signal}); see ${logPath}`);
      void shutdown(1);
    });

    const hub = await Page.connect(ports.voice, "hub.html");
    await Page.connect(ports.voice, "pill.html").then((pill) => pill.close());
    const snapshots = await snapshotStream(hub);
    const permissions = await snapshots.waitFor(
      (s) => s.permissions.accessibility !== "notDetermined",
      {
        timeoutMs: 15_000,
        label: "permission report",
      },
    );
    let models;
    try {
      models = (
        await snapshots.waitFor(
          (s) =>
            ["ready", "failed"].includes(s.models.asr.state) &&
            ["ready", "failed"].includes(s.models.cleanup.state),
          { timeoutMs: 180_000, label: "models settled" },
        )
      ).models;
    } catch {
      models = snapshots.items.at(-1).models;
    }
    hub.close();
    out({ ready: true, ...state, permissions: permissions.permissions, models });
  },

  async stop() {
    const state = readState();
    if (!state) return out("no verify instance recorded");
    if (alive(state.ownerPid)) {
      process.kill(state.ownerPid, "SIGTERM");
      for (let i = 0; i < 100 && alive(state.ownerPid); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (alive(state.electronPid)) {
      signalGroup(state.electronPid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 3000));
      signalGroup(state.electronPid, "SIGKILL");
    }
    rmSync(statePath, { force: true });
    rmSync(state.userData, { recursive: true, force: true });
    out({
      stopped: state.runId,
      evidence: existsSync(state.evidence) ? state.evidence : "none captured",
    });
  },

  async snapshot() {
    const hub = await connect("hub");
    out(await hub.evaluate("window.voice.getSnapshot()"));
    hub.close();
  },

  async text() {
    const hub = await connect("hub");
    out(
      await hub.evaluate(`(() => {
        const nav = document.querySelector("aside nav");
        const current = nav?.querySelector('[aria-current="page"]');
        return "[" + (nav?.getAttribute("aria-label") ?? "?") + " nav" + (current ? " > " + current.textContent.trim() : "") + "]\\n" + document.querySelector("main").innerText;
      })()`),
    );
    hub.close();
  },

  async eval() {
    const [which, expression] = args;
    if (!["hub", "pill"].includes(which) || !expression)
      fail("usage: eval <hub|pill> <expression>");
    const page = await connect(which);
    out(await page.evaluate(expression));
    page.close();
  },

  async wait() {
    const [which, expression, timeout = "10000"] = args;
    if (!["hub", "pill"].includes(which) || !expression)
      fail("usage: wait <hub|pill> <expression> [timeoutMs]");
    const page = await connect(which);
    try {
      out(await waitOn(page, expression, Number(timeout)));
    } finally {
      page.close();
    }
  },

  async click() {
    const [target, which = "hub"] = args;
    if (!target) fail("usage: click <accessible name | css:selector> [hub|pill]");
    const page = await connect(which);
    try {
      const result = await waitOn(
        page,
        `(() => {
          const matches = ${findExpression(target)};
          if (matches.length !== 1) return matches.length > 1 ? { ambiguous: matches.map(${ACCESSIBLE_NAME}) } : false;
          if (matches[0].disabled || matches[0].getAttribute("aria-disabled") === "true") return false;
          matches[0].click();
          return { clicked: (${ACCESSIBLE_NAME})(matches[0]) };
        })()`,
        5000,
      );
      if (result.ambiguous)
        fail(
          `${show(target)} matches ${result.ambiguous.length} elements: ${show(result.ambiguous)}`,
        );
      out(result);
    } finally {
      page.close();
    }
  },

  async shot() {
    const [name, which = "hub"] = args;
    if (!name) fail("usage: shot <name> [hub|pill]");
    const page = await connect(which);
    const { data } = await page.call("Page.captureScreenshot", { format: "png" });
    page.close();
    const path = join(evidenceDir(), `${name}.png`);
    writeFileSync(path, Buffer.from(data, "base64"));
    out(path);
  },

  async note() {
    const [name, ...rest] = args;
    if (!name || rest.length === 0) fail("usage: note <name> <text...>");
    const path = join(evidenceDir(), `${name}.txt`);
    appendFileSync(path, `${rest.join(" ")}\n`);
    out(path);
  },

  async dictate() {
    const [wav = "short.wav", ...flags] = args;
    const end = flags.find((f) => f.startsWith("--end="))?.slice(6) ?? "audio";
    if (!["audio", "escape", "immediate"].includes(end))
      fail("--end must be audio, escape, or immediate");
    const state = requireInstance();
    const others = otherVoiceProcesses(state.userData);
    if (others.length > 0) {
      fail(
        `refusing: another Voice is running and would record the real microphone on the synthetic key press. Ask the user to quit it.\n${others.join("\n")}`,
      );
    }
    const fixture = join(fixturesDir, wav);
    if (!existsSync(fixture)) fail(`missing fixture ${fixture}; run node scripts/fixtures.mjs`);
    const fnpost = (...keys) =>
      execFileSync(join(helperDir, ".build/debug/fnpost"), keys, { stdio: "ignore" });

    const hub = await connect("hub");
    const pill = await connect("pill");
    const { settings } = await hub.evaluate("window.voice.getSnapshot()");
    const snapshots = await snapshotStream(pill);
    const logOffset = statSync(state.logPath).size;
    const waitForLog = async (pattern, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const line = readFileSync(state.logPath, "utf8")
          .slice(logOffset)
          .split("\n")
          .find((l) => pattern.test(l));
        if (line) return line;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    };

    const targetEnv = {
      ...process.env,
      VOICE_E2E_TARGET_USER_DATA: join(state.userData, "target"),
    };
    delete targetEnv.ELECTRON_RUN_AS_NODE;
    const target = start(
      electronPath,
      [join(repoDir, "scripts/e2e-target/main.cjs"), `--remote-debugging-port=${ports.target}`],
      { env: targetEnv, stdio: "ignore" },
    );
    try {
      const field = 'document.getElementById("field")';
      const targetPage = await Page.connect(ports.target, "index.html");
      osascript(
        `tell application "System Events" to set frontmost of (first process whose unix id is ${target.pid}) to true`,
      );
      await waitOn(
        targetPage,
        `${field}.focus() || (document.hasFocus() && document.activeElement.id === "field")`,
        5000,
      );
      copyFileSync(fixture, state.fakeMicrophonePath);
      snapshots.skipToEnd();

      fnpost(settings.hotkey, "down");
      const pressedAt = performance.now();
      await snapshots.waitFor((s) => s.session.kind === "listening", {
        timeoutMs: 5000,
        label: "listening",
      });
      if (end === "audio")
        await waitForLog(/helper info: test\.audioFile ended$/, 60_000, "fixture to finish");
      if (end === "escape") fnpost("escape");
      else fnpost(settings.hotkey, "up");
      const heldMs = Math.round(performance.now() - pressedAt);
      let finalState;
      if (end === "escape") {
        finalState = await snapshots.waitFor((s) => s.session.kind === "idle", {
          timeoutMs: 5000,
          label: "idle",
        });
        fnpost(settings.hotkey, "up");
      } else {
        finalState = await snapshots.waitFor((s) => s.session.kind === "done", {
          timeoutMs: 90_000,
          label: "done",
        });
      }
      const timing =
        end === "escape"
          ? null
          : await waitForLog(/\[voice\] session \w+ outcome=/, 5000, "timing line").catch(
              () => null,
            );
      const result = {
        fixture: wav,
        end,
        hotkey: settings.hotkey,
        cleanup: settings.cleanup,
        heldMs,
        outcome: finalState.session.outcome ?? finalState.session.kind,
        inserted: await targetPage.evaluate(`${field}.value`),
        last: finalState.last,
        timing: timing?.replace(/^.*\[voice\] /, "") ?? null,
      };
      targetPage.close();
      const path = join(
        evidenceDir(),
        `dictate-${wav.replace(/\.wav$/, "")}-${end}-${Date.now()}.json`,
      );
      writeFileSync(path, JSON.stringify(result, null, 2));
      out({ ...result, evidence: path });
    } finally {
      rmSync(state.fakeMicrophonePath, { force: true });
      hub.close();
      pill.close();
      await stopChildren();
    }
  },

  help() {
    out(`usage: node .claude/skills/verify/scripts/voice-verify.mjs <command>
  doctor                         read-only health report
  launch                         start the disposable instance (foreground; run in background)
  stop                           tear down the instance this skill started; evidence survives
  snapshot                       full app snapshot JSON
  text                           current sidebar nav and visible page text
  click <name|css:sel> [page]    click the one visible element with that accessible name
  wait <page> <expr> [ms]        poll a page expression until truthy
  eval <page> <expr>             evaluate in hub or pill, print the result
  shot <name> [page]             screenshot into the evidence dir
  note <name> <text...>          append text evidence
  dictate [fixture.wav] [--end=audio|escape|immediate]`);
  },
};

if (!commands[command]) fail(`unknown command ${command}; try help`);
await commands[command]();
if (command !== "launch") process.exit(0);

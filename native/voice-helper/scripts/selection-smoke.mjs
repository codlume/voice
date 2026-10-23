import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stopChildren } from "../../../scripts/voice-app.mjs";
import { electronTarget, textEditTarget } from "../../../scripts/targets.mjs";
import { assert, helperBinary, refuseIfVoiceIsRunning, withHelper } from "./helper.mjs";

const target = process.argv[2];
assert(
  target === "textedit" || target === "electron",
  `usage: selection-smoke.mjs textedit|electron (got ${target})`,
);
refuseIfVoiceIsRunning();

const transformId = "polish";
const oneKeycode = 18;
const rightArrowKeycode = 124;
const paragraph = `Synthetic paragraph ${randomUUID()}: Ada met Grace on Thursday, 2024-05-02, at https://example.test/voice and said 42 words.`;

function osascript(script) {
  return execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();
}

function clipboardSha256() {
  return createHash("sha256")
    .update(execFileSync("pbpaste", { encoding: "utf8" }))
    .digest("hex");
}

function clipboardChangeCount() {
  return Number(
    execFileSync(
      "osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        "ObjC.import('AppKit'); $.NSPasteboard.generalPasteboard.changeCount",
      ],
      { encoding: "utf8" },
    ).trim(),
  );
}

async function settle(read, expected, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (value !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

function pressRightArrow() {
  osascript(`tell application "System Events" to key code ${rightArrowKeycode}`);
}

async function createTarget() {
  if (target === "textedit") return textEditTarget("selection-smoke");
  const userData = mkdtempSync(join(tmpdir(), "voice-selection-smoke-"));
  const electron = await electronTarget(userData);
  await electron.watchKeys();
  return {
    ...electron,
    async close() {
      electron.close();
      await stopChildren();
      rmSync(userData, { recursive: true, force: true });
    },
  };
}

async function pressShortcut(helper) {
  const before = helper.events.length;
  const pressedAt = performance.now();
  const fnpost = spawn(
    helperBinary("fnpost"),
    ["combo", String(oneKeycode), "option", "--side=left"],
    {
      stdio: "ignore",
    },
  );
  const exited = new Promise((resolve) => fnpost.on("exit", resolve));
  const event = await helper.waitFor((e) => e.type === "transform", {
    timeoutMs: 3_000,
    label: "transform",
  });
  const transformMs = performance.now() - pressedAt;
  assert(event.transformId === transformId, `transform event names ${event.transformId}`);
  return {
    transformMs,
    exited,
    hotkeys: () => helper.eventsSince(before).filter((e) => e.type === "hotkey"),
  };
}

async function readSelection(helper, id) {
  const sentAt = performance.now();
  helper.send({ type: "selection.read", id });
  const result = await helper.waitFor((e) => e.type === "selection.result" && e.id === id, {
    timeoutMs: 5_000,
    label: "selection.result",
  });
  return { result, readMs: performance.now() - sentAt };
}

async function insert(helper, id, text) {
  const sentAt = performance.now();
  helper.send({ type: "insert", id, text, html: null });
  const result = await helper.waitFor((e) => e.type === "insert.result" && e.id === id, {
    timeoutMs: 5_000,
    label: "insert.result",
  });
  return { result, insertMs: performance.now() - sentAt };
}

function timings(helper, since) {
  const found = {};
  for (const event of helper.eventsSince(since)) {
    if (event.type !== "log") continue;
    const [, what, ms] =
      /^selection (keys released|copy answered|copy unanswered) after (\d+) ms$/.exec(
        event.message,
      ) ?? [];
    if (what) found[what.replace(" ", "_")] = Number(ms);
  }
  return found;
}

const clipboardShaBefore = clipboardSha256();
const clipboardCountBefore = clipboardChangeCount();
const app = await createTarget();
const report = { target: app.name };
try {
  await withHelper({}, async (helper) => {
    await helper.waitFor((e) => e.type === "log" && e.message === "hotkey tap installed", {
      label: "hotkey tap installed",
    });
    helper.send({
      type: "hotkey.configure",
      key: "fn",
      toggleKey: null,
      transforms: [{ id: transformId, keycode: oneKeycode, modifiers: ["option"] }],
    });
    await app.open(paragraph);

    await app.selectAll();
    if (app.axSelectedText()) {
      assert(app.axSelectedText() === paragraph, "AX does not report the paragraph as selected");
    }
    const firstMark = helper.events.length;
    const press = await pressShortcut(helper);
    const read = await readSelection(helper, "run-1");
    await press.exited;
    assert(
      press.hotkeys().length === 0,
      `shortcut leaked hotkey events ${JSON.stringify(press.hotkeys())}`,
    );
    assert(read.result.outcome === "selected", `selection.result ${JSON.stringify(read.result)}`);
    assert(read.result.text === paragraph, `selected text ${JSON.stringify(read.result.text)}`);
    if (target === "textedit")
      assert(read.result.via === "accessibility", `via ${read.result.via}`);
    const unchanged = await app.read();
    assert(
      unchanged === paragraph,
      `the shortcut typed into the target: ${JSON.stringify(unchanged)}`,
    );
    const countAfterRead = clipboardChangeCount();
    const marker = `Voice transform result ${randomUUID()}`;
    const written = await insert(helper, "run-1", marker);
    assert(written.result.method !== "none", `insert.result ${JSON.stringify(written.result)}`);
    const landed = await settle(() => app.read(), marker);
    assert(landed === marker, `target text ${JSON.stringify(landed)} != ${JSON.stringify(marker)}`);
    const shaAfterInsert = await settle(clipboardSha256, clipboardShaBefore);
    assert(
      shaAfterInsert === clipboardShaBefore,
      `clipboard contents changed ${clipboardShaBefore} -> ${shaAfterInsert}`,
    );
    helper.send({ type: "transform.end", id: "run-1" });
    report.replace = {
      pressToTransformMs: Math.round(press.transformMs),
      readMs: Math.round(read.readMs),
      via: read.result.via,
      insertMethod: written.result.method,
      insertMs: Math.round(written.insertMs),
      clipboardChangeCountDelta: {
        read: countAfterRead - clipboardCountBefore,
        total: clipboardChangeCount() - clipboardCountBefore,
      },
      helper: timings(helper, firstMark),
      keysSeenByTarget: await app.keysSeen(),
    };

    pressRightArrow();
    const countBeforeEmpty = clipboardChangeCount();
    const emptyMark = helper.events.length;
    const emptyPress = await pressShortcut(helper);
    const empty = await readSelection(helper, "run-2");
    await emptyPress.exited;
    assert(
      empty.result.outcome === "failed" && empty.result.reason === "noSelection",
      `collapsed selection gave ${JSON.stringify(empty.result)}`,
    );
    helper.send({ type: "transform.end", id: "run-2" });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const countAfterEmpty = clipboardChangeCount();
    assert(
      countAfterEmpty === countBeforeEmpty,
      `empty read touched the clipboard ${countBeforeEmpty} -> ${countAfterEmpty}`,
    );
    report.noSelection = {
      readMs: Math.round(empty.readMs),
      helper: timings(helper, emptyMark),
      clipboardChangeCountDelta: countAfterEmpty - countBeforeEmpty,
    };

    await app.selectAll();
    const movedPress = await pressShortcut(helper);
    const moved = await readSelection(helper, "run-3");
    await movedPress.exited;
    assert(
      moved.result.outcome === "selected" && moved.result.text === marker,
      `third read ${JSON.stringify(moved.result)}`,
    );
    pressRightArrow();
    const refused = await insert(helper, "run-3", "must not land");
    assert(
      refused.result.method === "none" && refused.result.reason === "selectionChanged",
      `insert after a press gave ${JSON.stringify(refused.result)}`,
    );
    const kept = await app.read();
    assert(kept === marker, `refused insert changed the target: ${JSON.stringify(kept)}`);
    helper.send({ type: "transform.end", id: "run-3" });
    const shaEnd = await settle(clipboardSha256, clipboardShaBefore);
    assert(
      shaEnd === clipboardShaBefore,
      `clipboard contents changed by the end ${clipboardShaBefore} -> ${shaEnd}`,
    );
    report.selectionChanged = {
      via: moved.result.via,
      insertReason: refused.result.reason,
      targetText: "unchanged",
    };
    report.clipboardChangeCountTotalDelta = clipboardChangeCount() - clipboardCountBefore;
  });
  console.log(JSON.stringify(report));
} finally {
  await app.close();
}

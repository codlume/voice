import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { electronTarget } from "../../../scripts/targets.mjs";
import {
  assert,
  dictateFixture,
  prepareAsr,
  refuseIfVoiceIsRunning,
  withHelper,
} from "./helper.mjs";

refuseIfVoiceIsRunning();

function frontWindowTitle() {
  return execFileSync(
    "osascript",
    [
      "-e",
      'tell application "System Events" to get name of window 1 of (first process whose frontmost is true)',
    ],
    { encoding: "utf8" },
  ).trim();
}

function clipboardSha256() {
  const content = execFileSync("pbpaste", { encoding: "utf8" });
  return createHash("sha256").update(content).digest("hex");
}

async function settle(read, expected, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (value !== expected && Date.now() < deadline) {
    await sleep(50);
    value = await read();
  }
  return value;
}

const clipboardBefore = clipboardSha256();
const userData = mkdtempSync(join(tmpdir(), "voice-title-tick-"));
const target = await electronTarget(userData);
try {
  await target.open();
  const titleBefore = frontWindowTitle();
  const titleDuring = `${titleBefore} (3)`;
  await withHelper({}, async (helper) => {
    await prepareAsr(helper);
    const id = "title-tick";
    const expected = `Voice title tick ${randomUUID()}`;
    const from = helper.events.length;
    const baselineCaptured = () =>
      helper
        .eventsSince(from)
        .some((event) => event.type === "log" && event.message === "target focus captured");
    const capture = await dictateFixture(helper, "short.wav", id, "en", {
      onStarted: async () => {
        assert(await settle(baselineCaptured, true), "the focus baseline was not captured");
        await target.setTitle(titleDuring);
        const seen = await settle(frontWindowTitle, titleDuring);
        assert(seen === titleDuring, `window title is ${JSON.stringify(seen)} during capture`);
      },
    });
    assert(capture.transcript.text.trim() !== "", "capture returned an empty transcript");
    helper.send({ type: "insert", id, text: expected, html: null });
    const result = await helper.waitFor(
      (event) => event.type === "insert.result" && event.id === id,
      { label: "insert.result" },
    );
    assert(
      result.method === "paste",
      `insert.result method ${result.method} reason ${result.reason ?? ""}`,
    );
    const actual = await settle(() => target.read(), expected);
    assert(
      actual === expected,
      `target text ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
    );
    const restored = await settle(clipboardSha256, clipboardBefore);
    assert(restored === clipboardBefore, "clipboard was not restored after the insert");
    console.log(
      JSON.stringify({ titleBefore, titleDuring, method: result.method, inserted: true }),
    );
  });
} finally {
  await target.close();
  rmSync(userData, { recursive: true, force: true });
}

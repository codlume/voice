import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assert,
  dictateFixture,
  prepareAsr,
  refuseIfVoiceIsRunning,
  withHelper,
} from "./helper.mjs";

const mode = process.argv[2];
assert(mode === "ax" || mode === "recovery", `usage: insert-smoke.mjs ax|recovery (got ${mode})`);
refuseIfVoiceIsRunning();

function osascript(script) {
  return execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();
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
  let value = read();
  while (value !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = read();
  }
  return value;
}

const textEditWasRunning = osascript('application "TextEdit" is running') === "true";
const clipboardBefore = clipboardChangeCount();

// A named file, as in scripts/e2e.mjs. An untitled document can fail to appear on a cold launch,
// and closing one can raise a save sheet that blocks every later AppleEvent.
const dir = mkdtempSync(join(tmpdir(), "voice-insert-smoke-"));
const name = `insert-${mode}-${randomUUID()}.txt`;
const file = join(dir, name);
const document = `document ${JSON.stringify(name)}`;
writeFileSync(file, "");
osascript(
  `tell application "TextEdit"\nopen POSIX file ${JSON.stringify(file)}\nactivate\nend tell`,
);
try {
  await withHelper(
    { env: mode === "recovery" ? { VOICE_HELPER_FORCE_RECOVERY: "1" } : {} },
    async (helper) => {
      await prepareAsr(helper);
      const id = `insert-${mode}`;
      const expected = `Voice ${mode} insert ${randomUUID()}`;
      const capture = await dictateFixture(helper, "short.wav", id);
      assert(capture.transcript.text.trim() !== "", "capture returned an empty transcript");
      helper.send({ type: "insert", id, text: expected });
      const result = await helper.waitFor(
        (event) => event.type === "insert.result" && event.id === id,
        {
          label: "insert.result",
        },
      );
      const expectedMethod = mode === "ax" ? "accessibility" : "none";
      assert(
        result.method === expectedMethod,
        `insert.result method ${result.method} reason ${result.reason ?? ""}`,
      );
      if (mode === "recovery") {
        assert(result.reason === "failed", `recovery reason ${result.reason ?? ""}`);
      }
      const expectedText = mode === "ax" ? expected : "";
      const actual = await settle(
        () => osascript(`tell application "TextEdit" to get text of ${document}`),
        expectedText,
      );
      assert(actual === expectedText, "document did not match the expected insertion outcome");
      const clipboardAfter = clipboardChangeCount();
      assert(clipboardAfter === clipboardBefore, "clipboard changed during insertion");
      console.log(
        JSON.stringify({
          mode,
          method: result.method,
          targetMatched: true,
          clipboardUnchanged: true,
        }),
      );
    },
  );
} finally {
  try {
    osascript(`tell application "TextEdit" to close ${document} saving no`);
    // Quitting over a document this script did not open, such as a restored autosave, raises a
    // save sheet, so TextEdit stays up unless this script launched it and nothing else is open.
    const remaining = Number(osascript('tell application "TextEdit" to count documents'));
    if (!textEditWasRunning && remaining === 0) osascript('tell application "TextEdit" to quit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

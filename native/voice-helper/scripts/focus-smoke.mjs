import { createHash, randomUUID } from "node:crypto";
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
assert(mode === "ax" || mode === "paste", `usage: focus-smoke.mjs ax|paste (got ${mode})`);
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

function clipboardSha256() {
  const content = execFileSync("pbpaste", { encoding: "utf8" });
  return createHash("sha256").update(content).digest("hex");
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
const clipboardShaBefore = clipboardSha256();

// Named files, as in insert-smoke.mjs: an untitled document can fail to appear on a cold launch,
// and closing one can raise a save sheet that blocks every later AppleEvent.
const dir = mkdtempSync(join(tmpdir(), "voice-focus-smoke-"));
function createDocument(label) {
  const name = `focus-${label}-${randomUUID()}.txt`;
  const file = join(dir, name);
  writeFileSync(file, "");
  return { name, file, ref: `document ${JSON.stringify(name)}` };
}
// Opening a file TextEdit already shows brings that window to the front and makes it key, so one
// call both opens a document and switches to it.
function bringToFront(doc) {
  osascript(
    `tell application "TextEdit"\nopen POSIX file ${JSON.stringify(doc.file)}\nactivate\nend tell`,
  );
  const front = osascript('tell application "TextEdit" to get name of document 1');
  assert(front === doc.name, `front document is ${JSON.stringify(front)}, not ${doc.name}`);
}
const textOf = (doc) => osascript(`tell application "TextEdit" to get text of ${doc.ref}`);

async function insert(helper, id, text) {
  helper.send({ type: "insert", id, text });
  return helper.waitFor((event) => event.type === "insert.result" && event.id === id, {
    label: "insert.result",
  });
}

const a = createDocument("a");
const b = createDocument("b");
bringToFront(b);
bringToFront(a);
try {
  await withHelper(
    { env: mode === "paste" ? { VOICE_HELPER_FORCE_PASTE: "1" } : {} },
    async (helper) => {
      await prepareAsr(helper);

      const controlText = `Voice focus control ${randomUUID()}`;
      const controlCapture = await dictateFixture(helper, "short.wav", "focus-control");
      assert(
        controlCapture.transcript.text.trim() !== "",
        "control capture returned an empty transcript",
      );
      const control = await insert(helper, "focus-control", controlText);
      assert(
        control.method === (mode === "ax" ? "accessibility" : "paste"),
        `control insert.result method ${control.method} reason ${control.reason ?? ""}`,
      );
      const controlActual = await settle(() => textOf(a), controlText);
      assert(
        controlActual === controlText,
        `document A text ${JSON.stringify(controlActual)} != ${JSON.stringify(controlText)}`,
      );

      const restored = await settle(clipboardSha256, clipboardShaBefore);
      assert(
        restored === clipboardShaBefore,
        "clipboard was not restored after the control insert",
      );
      const switchClipboardBefore = clipboardChangeCount();
      const aBefore = textOf(a);
      const bBefore = textOf(b);
      const switchText = `Voice focus switch ${randomUUID()}`;
      const switchCapture = await dictateFixture(helper, "short.wav", "focus-switch");
      assert(
        switchCapture.transcript.text.trim() !== "",
        "switch capture returned an empty transcript",
      );
      bringToFront(b);
      const switched = await insert(helper, "focus-switch", switchText);
      assert(
        switched.method === "none" && switched.reason === "focusChanged",
        `switch insert.result method ${switched.method} reason ${switched.reason ?? ""}`,
      );
      const aAfter = textOf(a);
      const bAfter = textOf(b);
      assert(aAfter === aBefore, `document A changed to ${JSON.stringify(aAfter)}`);
      assert(bAfter === bBefore, `document B changed to ${JSON.stringify(bAfter)}`);

      const clipboardAfter = clipboardChangeCount();
      assert(
        clipboardAfter === switchClipboardBefore,
        `refused insert changed the clipboard ${switchClipboardBefore} -> ${clipboardAfter}`,
      );
      assert(
        mode === "paste" || clipboardAfter === clipboardBefore,
        `clipboard changeCount changed ${clipboardBefore} -> ${clipboardAfter}`,
      );
      console.log(
        JSON.stringify({
          mode,
          control: { method: control.method, documentA: "transcript" },
          switch: {
            method: switched.method,
            reason: switched.reason ?? null,
            documentA: "unchanged",
            documentB: "unchanged",
          },
          clipboardChangeCount: clipboardAfter,
        }),
      );
    },
  );
} finally {
  try {
    for (const doc of [a, b]) {
      osascript(`tell application "TextEdit" to close ${doc.ref} saving no`);
    }
    // Quitting over a document this script did not open, such as a restored autosave, raises a
    // save sheet, so TextEdit stays up unless this script launched it and nothing else is open.
    const remaining = Number(osascript('tell application "TextEdit" to count documents'));
    if (!textEditWasRunning && remaining === 0) osascript('tell application "TextEdit" to quit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

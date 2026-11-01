import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { textEditTarget } from "../../../scripts/targets.mjs";
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
  let value = await read();
  while (value !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

async function insert(helper, id, text) {
  helper.send({ type: "insert", id, text, html: null, keepOnClipboard: false });
  return helper.waitFor((event) => event.type === "insert.result" && event.id === id, {
    label: "insert.result",
  });
}

const clipboardBefore = clipboardChangeCount();
const clipboardShaBefore = clipboardSha256();
const textEdit = textEditTarget(`focus-${mode}`);
try {
  const b = await textEdit.open();
  const a = await textEdit.open();
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
      const controlActual = await settle(() => a.read(), controlText);
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
      const aBefore = await a.read();
      const bBefore = await b.read();
      const switchText = `Voice focus switch ${randomUUID()}`;
      const switchCapture = await dictateFixture(helper, "short.wav", "focus-switch");
      assert(
        switchCapture.transcript.text.trim() !== "",
        "switch capture returned an empty transcript",
      );
      await b.front();
      const switched = await insert(helper, "focus-switch", switchText);
      assert(
        switched.method === "none" && switched.reason === "focusChanged",
        `switch insert.result method ${switched.method} reason ${switched.reason ?? ""}`,
      );
      const aAfter = await a.read();
      const bAfter = await b.read();
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
  textEdit.close();
}

// Insertion smoke against a real TextEdit document.
// Usage: node scripts/insert-smoke.mjs ax|paste
// `paste` forces the clipboard path (VOICE_HELPER_FORCE_PASTE=1) and checks the clipboard survives.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { assert, dictateFixture, prepareAsr, withHelper } from "./helper.mjs";

const mode = process.argv[2];
assert(mode === "ax" || mode === "paste", `usage: insert-smoke.mjs ax|paste (got ${mode})`);

function osascript(script) {
  return execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();
}

function clipboardSha256() {
  const content = execFileSync("pbpaste", { encoding: "utf8" });
  return createHash("sha256").update(content).digest("hex");
}

const textEditWasRunning = osascript('application "TextEdit" is running') === "true";
const sentinel = `voice clipboard sentinel ${randomUUID()}`;
execFileSync("pbcopy", { input: sentinel });
const clipboardBefore = clipboardSha256();

osascript('tell application "TextEdit"\nactivate\nmake new document\nend tell');
try {
  await withHelper(
    { env: mode === "paste" ? { VOICE_HELPER_FORCE_PASTE: "1" } : {} },
    async (helper) => {
      await prepareAsr(helper);
      const id = `insert-${mode}`;
      const expected = `Voice ${mode} insert ${randomUUID()}`;
      // The capture records TextEdit as the frontmost app; silence keeps the transcript step short.
      await dictateFixture(helper, "silence.wav", id);
      helper.send({ type: "insert", id, text: expected });
      const result = await helper.waitFor(
        (event) => event.type === "insert.result" && event.id === id,
        {
          label: "insert.result",
        },
      );
      const expectedMethod = mode === "ax" ? "accessibility" : "paste";
      assert(
        result.method === expectedMethod,
        `insert.result method ${result.method} reason ${result.reason ?? ""}`,
      );
      // Give TextEdit a moment to apply the paste keystroke and the helper to restore the clipboard.
      await new Promise((resolve) => setTimeout(resolve, 600));
      const actual = osascript('tell application "TextEdit" to get text of document 1');
      assert(
        actual === expected,
        `document text ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
      );
      const clipboardAfter = clipboardSha256();
      assert(
        clipboardAfter === clipboardBefore,
        `clipboard sha256 changed ${clipboardBefore} -> ${clipboardAfter}`,
      );
      console.log(
        JSON.stringify({
          mode,
          method: result.method,
          documentText: actual,
          clipboardSha256: clipboardAfter,
        }),
      );
    },
  );
} finally {
  osascript('tell application "TextEdit" to close document 1 saving no');
  if (!textEditWasRunning) osascript('tell application "TextEdit" to quit');
}

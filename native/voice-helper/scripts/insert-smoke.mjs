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
assert(mode === "ax" || mode === "paste", `usage: insert-smoke.mjs ax|paste (got ${mode})`);
refuseIfVoiceIsRunning();

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

// The helper must hand back whatever the developer already had, so the smoke never writes it.
const clipboardBefore = clipboardSha256();
const textEdit = textEditTarget(`insert-${mode}`);
try {
  await textEdit.open();
  await withHelper(
    { env: mode === "paste" ? { VOICE_HELPER_FORCE_PASTE: "1" } : {} },
    async (helper) => {
      await prepareAsr(helper);
      const id = `insert-${mode}`;
      const expected = `Voice ${mode} insert ${randomUUID()}`;
      const capture = await dictateFixture(helper, "short.wav", id);
      assert(capture.transcript.text.trim() !== "", "capture returned an empty transcript");
      helper.send({ type: "insert", id, text: expected, html: null, keepOnClipboard: false });
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
      // insert.result can arrive before TextEdit handles the pasted Cmd+V, and the helper
      // restores the clipboard only after that, so both are awaited rather than read once.
      const actual = await settle(() => textEdit.read(), expected);
      assert(
        actual === expected,
        `document text ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
      );
      const clipboardAfter = await settle(clipboardSha256, clipboardBefore);
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
  textEdit.close();
}

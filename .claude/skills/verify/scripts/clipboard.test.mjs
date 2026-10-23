import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { clipboardKept, restoreClipboard, saveClipboard } from "../../../../scripts/targets.mjs";

const PNG = "iVBORw0KGgo=";
const RTF = "e1xydGYxIHN5bnRoZXRpY30=";

// A private pasteboard, so the test never reads or writes the user's clipboard.
function scratchPasteboard(t) {
  const pasteboard = `voice-test-${randomUUID()}`;
  const jxa = (body) =>
    execFileSync(
      "osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        `ObjC.import("AppKit"); const board = $.NSPasteboard.pasteboardWithName(${JSON.stringify(pasteboard)}); ${body}`,
      ],
      { encoding: "utf8" },
    ).trim();
  const data = (base64) => `$.NSData.alloc.initWithBase64EncodedStringOptions("${base64}", 0)`;
  t.after(() => jxa("board.releaseGlobally; ''"));
  return {
    pasteboard,
    clear: () => jxa("board.clearContents"),
    putImageAndRichText: () =>
      jxa(
        `board.clearContents; const item = $.NSPasteboardItem.alloc.init; item.setDataForType(${data(PNG)}, "public.png"); item.setDataForType(${data(RTF)}, "public.rtf"); board.writeObjects($([item]))`,
      ),
    putText: (text) =>
      jxa(
        `board.clearContents; board.setStringForType(${JSON.stringify(text)}, "public.utf8-plain-text")`,
      ),
    types: () => JSON.parse(jxa("JSON.stringify(ObjC.deepUnwrap(board.types) ?? [])")),
  };
}

test("an image and rich text clipboard that is overwritten is detected and restored", async (t) => {
  const board = scratchPasteboard(t);
  board.putImageAndRichText();
  const saved = saveClipboard(board);

  assert.equal(await clipboardKept(saved, 0), true);
  assert.equal(restoreClipboard(saved), false, "an unchanged clipboard is not rewritten");

  board.putText("synthetic transform result");
  assert.equal(await clipboardKept(saved, 100), false);
  assert.equal(restoreClipboard(saved), true);
  assert.equal(saveClipboard(board).digest, saved.digest);
  assert.ok(board.types().includes("public.png"), "the image is back");
  assert.ok(board.types().includes("public.rtf"), "the rich text is back");
});

test("an empty clipboard is told apart from one that holds only an image", async (t) => {
  const board = scratchPasteboard(t);
  board.clear();
  const empty = saveClipboard(board);
  board.putImageAndRichText();
  assert.notEqual(saveClipboard(board).digest, empty.digest);
  assert.equal(restoreClipboard(empty), true);
  assert.deepEqual(board.types(), []);
});

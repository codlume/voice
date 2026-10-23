import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import {
  announcedPorts,
  electronPath,
  Page,
  repoDir,
  signalGroup,
  smokeEnvironment,
  start,
} from "./voice-app.mjs";

const execFileAsync = promisify(execFile);
const show = (value) => JSON.stringify(value);

function osascript(script) {
  return execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();
}

async function until(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(message);
    await sleep(50);
  }
}

export async function activate(pid, name) {
  osascript(
    `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
  );
  await until(
    () =>
      Number(
        osascript(
          'tell application "System Events" to unix id of first process whose frontmost is true',
        ),
      ) === pid,
    5000,
    `${name} (pid ${pid}) did not become frontmost`,
  );
}

// Each document is a named file: an untitled one can fail to appear on a cold launch and is
// renamed from its content, and closing one can raise a save sheet that blocks every later
// AppleEvent. Only documents this target opened are closed, and TextEdit is quit only when this
// target launched it, because quitting over a restored autosave raises that same sheet.
export function textEditTarget(label) {
  const wasRunning = osascript('application "TextEdit" is running') === "true";
  const dir = mkdtempSync(join(tmpdir(), `voice-${label}-`));
  const documents = [];
  let current;

  const reading = (document) => async () => {
    const { stdout } = await execFileAsync(
      "osascript",
      ["-e", `tell application "TextEdit" to get text of ${document.ref}`],
      { encoding: "utf8", timeout: 1000, killSignal: "SIGKILL" },
    );
    return stdout.trim();
  };

  return {
    name: "TextEdit",
    async open(text = "") {
      const name = `${label}-${randomUUID()}.txt`;
      const file = join(dir, name);
      const document = { name, file, ref: `document ${show(name)}` };
      document.read = reading(document);
      writeFileSync(file, text);
      documents.push(document);
      // Opening a file TextEdit already shows brings that window to the front and makes it key.
      const bringUp = async () => {
        osascript(`tell application "TextEdit"\nopen POSIX file ${show(file)}\nactivate\nend tell`);
        const pid = Number(
          osascript('tell application "System Events" to unix id of process "TextEdit"'),
        );
        await activate(pid, "TextEdit");
        const front = osascript('tell application "TextEdit" to get name of document 1');
        if (front !== name) throw new Error(`front document is ${show(front)}, not ${name}`);
        current = document;
      };
      document.front = bringUp;
      await bringUp();
      await until(
        async () => (await document.read()) === text,
        10_000,
        `the TextEdit document ${name} did not open with its text`,
      );
      return document;
    },
    selectAll() {
      osascript('tell application "System Events" to keystroke "a" using command down');
    },
    axSelectedText() {
      try {
        return osascript(
          'tell application "System Events" to tell process "TextEdit" to get value of attribute "AXSelectedText" of (value of attribute "AXFocusedUIElement")',
        );
      } catch {
        return null;
      }
    },
    read: () => current.read(),
    front: () => current.front(),
    keysSeen: () => null,
    close() {
      try {
        for (const { ref } of documents.splice(0)) {
          osascript(`tell application "TextEdit" to if exists ${ref} then close ${ref} saving no`);
        }
        const remaining = Number(osascript('tell application "TextEdit" to count documents'));
        if (!wasRunning && remaining === 0) osascript('tell application "TextEdit" to quit');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

const FIELD = 'document.getElementById("field")';

async function stopGroup(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  signalGroup(child.pid, "SIGTERM");
  const force = setTimeout(() => signalGroup(child.pid, "SIGKILL"), 3000);
  await exited;
  clearTimeout(force);
}

// The target is spawned detached, so it outlives this script unless close() stops it.
export async function electronTarget(userData, { wait = (promise) => promise } = {}) {
  const env = smokeEnvironment(userData, { VOICE_E2E_TARGET_USER_DATA: join(userData, "target") });
  const child = start(
    electronPath(),
    [join(repoDir, "scripts/e2e-target/main.cjs"), "--remote-debugging-port=0"],
    { env, stdio: ["ignore", "ignore", "pipe"] },
  );
  let page;
  try {
    const { DevTools: port } = await wait(announcedPorts(child, ["DevTools"]));
    page = await wait(Page.connect(port, "index.html"));
  } catch (error) {
    await stopGroup(child);
    throw error;
  }
  const front = () => activate(child.pid, "the scratch target");
  return {
    name: "Electron target",
    async open(text = "") {
      await front();
      await until(
        () =>
          page.evaluate(
            `(${FIELD}.value = ${show(text)}, ${FIELD}.focus(), document.hasFocus() && document.activeElement.id === "field")`,
          ),
        5000,
        "the textarea did not take focus",
      );
    },
    selectAll: () => page.evaluate(`${FIELD}.select(), ${FIELD}.selectionEnd`),
    axSelectedText: () => null,
    read: () => page.evaluate(`${FIELD}.value`),
    front,
    watchKeys: () =>
      page.evaluate(
        `window.__keys = []; document.addEventListener("keydown", (e) => window.__keys.push({ key: e.key, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey, ctrl: e.ctrlKey }), true); true`,
      ),
    keysSeen: () => page.evaluate("JSON.stringify(window.__keys.splice(0))"),
    async close() {
      page.close();
      await stopGroup(child);
    },
  };
}

const READ_CLIPBOARD = `ObjC.import("AppKit");
function run([name]) {
  const board = name ? $.NSPasteboard.pasteboardWithName(name) : $.NSPasteboard.generalPasteboard;
  const items = board.pasteboardItems;
  const saved = [];
  for (let i = 0; i < (items.isNil() ? 0 : items.count); i++) {
    const item = items.objectAtIndex(i);
    const entries = [];
    for (let j = 0; j < item.types.count; j++) {
      const type = item.types.objectAtIndex(j);
      const data = item.dataForType(type);
      entries.push([type.js, data.isNil() ? null : data.base64EncodedStringWithOptions(0).js]);
    }
    saved.push(entries);
  }
  return JSON.stringify(saved);
}`;

const WRITE_CLIPBOARD = `ObjC.import("AppKit");
function run([name]) {
  const board = name ? $.NSPasteboard.pasteboardWithName(name) : $.NSPasteboard.generalPasteboard;
  const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const items = JSON.parse($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding).js);
  board.clearContents;
  const written = items.map((entries) => {
    const item = $.NSPasteboardItem.alloc.init;
    for (const [type, data] of entries)
      if (data !== null)
        item.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions(data, 0), type);
    return item;
  });
  if (written.length > 0 && !board.writeObjects($(written))) throw new Error("writeObjects failed");
  return "";
}`;

function clipboardJxa(script, pasteboard, input) {
  return execFileSync("osascript", ["-l", "JavaScript", "-e", script, pasteboard], {
    encoding: "utf8",
    input,
    maxBuffer: 1024 ** 3,
  });
}

// Every type of every item, so an image or rich text counts, not only the plain text pbpaste
// reads. The contents stay in memory for restoreClipboard and are never printed or written.
// A type whose data cannot be read (a lazy promise) is kept as null and cannot be restored.
export function saveClipboard({ pasteboard = "" } = {}) {
  const json = clipboardJxa(READ_CLIPBOARD, pasteboard).trim();
  return {
    pasteboard,
    items: JSON.parse(json),
    digest: createHash("sha256").update(json).digest("hex"),
  };
}

export async function clipboardKept(saved, timeoutMs = 3000) {
  return until(
    () => saveClipboard({ pasteboard: saved.pasteboard }).digest === saved.digest,
    timeoutMs,
    "the clipboard changed",
  ).catch(() => false);
}

// Returns whether it had to write, so the caller can report that the run changed the clipboard.
export function restoreClipboard(saved) {
  if (saveClipboard({ pasteboard: saved.pasteboard }).digest === saved.digest) return false;
  clipboardJxa(WRITE_CLIPBOARD, saved.pasteboard, JSON.stringify(saved.items));
  return true;
}

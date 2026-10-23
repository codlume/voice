// The apps that verification drives text into: a named TextEdit document and the scratch Electron
// textarea. Every smoke and verify command that needs a focused text field starts from here.
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  smokeEnvironment,
  start,
} from "./voice-app.mjs";

const execFileAsync = promisify(execFile);
const show = (value) => JSON.stringify(value);

function osascript(script) {
  return execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();
}

// Resolves with the first truthy result of check, which may be async.
async function until(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(message);
    await sleep(50);
  }
}

// Makes the process frontmost and waits until the OS agrees, so a posted key reaches it.
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
    // Opens a new document holding text and makes it the current one. Returns a handle whose
    // front() brings that document back, as when the user switches windows.
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
    // What accessibility reports as selected, or null when it reports nothing.
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

// The scratch Electron app with one textarea. userData is the caller's to create and remove, and
// stopChildren() ends the process. wait wraps each pending step so an interrupt can cut it short.
export async function electronTarget(userData, { wait = (promise) => promise } = {}) {
  const env = smokeEnvironment(userData, { VOICE_E2E_TARGET_USER_DATA: join(userData, "target") });
  const child = start(
    electronPath(),
    [join(repoDir, "scripts/e2e-target/main.cjs"), "--remote-debugging-port=0"],
    { env, stdio: ["ignore", "ignore", "pipe"] },
  );
  const { DevTools: port } = await wait(announcedPorts(child, ["DevTools"]));
  const page = await wait(Page.connect(port, "index.html"));
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
    // Every keydown the page sees, with its modifiers, so a leaked Option on a posted Cmd+C
    // shows up as alt: true on the "c" event.
    watchKeys: () =>
      page.evaluate(
        `window.__keys = []; document.addEventListener("keydown", (e) => window.__keys.push({ key: e.key, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey, ctrl: e.ctrlKey }), true); true`,
      ),
    keysSeen: () => page.evaluate("JSON.stringify(window.__keys.splice(0))"),
    close: () => page.close(),
  };
}

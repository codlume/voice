import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const executablePath = resolve(
  "out/Voice Development-darwin-arm64/Voice Development.app/Contents/MacOS/Voice Development",
);
const transcript = "Hello, Priya. Do not deploy VX-204.";
const model = {
  model_uuid: "40bd3654-e622-47c4-a111-63a61b23bfe8",
  model_info: { version: "2025-04-17.21547" },
};

// Deterministic Deepgram stand-in: every attempt receives the same provider-final text.
async function fixtureServer() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const attempts: Buffer[][] = [];
  server.on("connection", (socket) => {
    const frames: Buffer[] = [];
    attempts.push(frames);
    socket.on("message", (data, binary) => {
      if (binary) {
        frames.push(Buffer.from(data.toString("hex"), "hex"));
        return;
      }
      if (JSON.parse(data.toString()).type !== "CloseStream") return;
      const seconds = Buffer.concat(frames).length / 32_000;
      socket.send(
        JSON.stringify({
          type: "Results",
          start: 0,
          duration: seconds,
          is_final: true,
          channel_index: [0, 1],
          metadata: model,
          channel: { alternatives: [{ transcript }] },
        }),
      );
      socket.send(JSON.stringify({ type: "Metadata", duration: seconds, channels: 1 }));
      socket.close(1000);
    });
  });
  return {
    attempts,
    url: `ws://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
async function launch(directory: string, providerUrl: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  return electron.launch({
    executablePath,
    args: [`--voice-test-data=${directory}`],
    env: { ...env, VOICE_TEST_CAPTURE: "synthetic", VOICE_TEST_PROVIDER_URL: providerUrl },
  });
}
const shortcut = (app: ElectronApplication, action: string) =>
  app.evaluate(
    (_electron, input) =>
      (globalThis as { voiceTest?: { shortcut: (action: string) => void } }).voiceTest?.shortcut(
        input,
      ),
    action,
  );
const snapshot = (page: Page) =>
  page.evaluate(async () => {
    const reply = await window.voice.command({ type: "status.get" });
    if (!reply.ok || !reply.session) throw new Error("Session state unavailable");
    return { session: reply.session, status: reply.status };
  });
const panelState = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const panel = windows.find((w) => w.webContents.getURL().includes("view=status"));
    const main = windows.find((w) => !w.webContents.getURL().includes("view=status"));
    return {
      visible: panel?.isVisible() ?? null,
      focused: panel?.isFocused() ?? null,
      focusable: panel?.isFocusable() ?? null,
      alwaysOnTop: panel?.isAlwaysOnTop() ?? null,
      mainFocused: main?.isFocused() ?? null,
    };
  });
const isPanelPage = (page: Page) => page.url().includes("view=status");
const panelPage = async (app: ElectronApplication) =>
  app.windows().find(isPanelPage) ?? app.waitForEvent("window", { predicate: isPanelPage });

test("packaged shortcut dictation runs one session per press, shows non-activating status, and keeps an unplaceable transcript in recovery", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "voice-dictation-"));
  const server = await fixtureServer();
  const app = await launch(directory, server.url);
  const appProcess = app.process();
  try {
    const page = await app.firstWindow();
    const status = page.getByTestId("dictation-status");
    await expect(page.getByRole("button", { name: "Start practice", exact: true })).toBeEnabled();
    const panel = await panelPage(app);
    expect(await panelState(app)).toMatchObject({ visible: false, focusable: false });
    // Make Voice itself the frontmost app, so the session has no external target and the
    // outcome does not depend on whatever else is open on the machine.
    await app.evaluate(({ app: application }) => application.focus({ steal: true }));
    await expect.poll(async () => (await panelState(app)).mainFocused).toBe(true);
    await shortcut(app, "hold.up");
    expect(server.attempts).toHaveLength(0);
    await shortcut(app, "hold.down");
    await expect(status).toContainText("Recording. Release the shortcut to finish.");
    await expect(panel.getByTestId("panel-status")).toContainText("Recording");
    expect(await panelState(app)).toMatchObject({
      visible: true,
      focused: false,
      alwaysOnTop: true,
    });
    await panel.screenshot({ path: "test-results/dictation-panel-recording.png" });
    await shortcut(app, "hold.down");
    await expect.poll(() => server.attempts[0]?.length ?? 0).toBeGreaterThan(10);
    expect(server.attempts).toHaveLength(1);
    await shortcut(app, "hold.up");
    await shortcut(app, "hold.down");
    await expect(status).toContainText("Not inserted. No text field was focused");
    const first = await snapshot(page);
    expect(first.session.recovery).toEqual([
      expect.objectContaining({
        text: transcript,
        transcription: "complete",
        delivery: "failed",
        hasAudio: false,
        cause: expect.stringContaining("No text field was focused"),
      }),
    ]);
    expect(server.attempts).toHaveLength(1);
    await expect.poll(async () => (await panelState(app)).visible, { timeout: 10_000 }).toBe(false);
    const recovery = page.getByRole("region", { name: "Temporary recovery" });
    const entry = recovery.getByRole("article", { name: "Recovery session 1" });
    await expect(entry).toContainText("Delivery failed. Text remains available.");
    await entry.screenshot({ path: "test-results/dictation-recovery-failed.png" });
    await entry.getByRole("button", { name: "Paste", exact: true }).click();
    await expect(page.getByTestId("recovery-status")).toContainText("Click into the field");
    expect(await panelState(app)).toMatchObject({ visible: true, focused: false });
    await expect(panel.getByTestId("panel-status")).toContainText("Paste");
    await expect(page.getByRole("button", { name: "Start practice", exact: true })).toBeDisabled();
    await shortcut(app, "hold.down");
    expect(server.attempts).toHaveLength(1);
    await page.getByRole("button", { name: "Cancel paste", exact: true }).click();
    await expect(page.getByTestId("recovery-status")).toContainText("Paste cancelled");
    await expect(entry.getByRole("textbox")).toHaveValue(transcript);
    await shortcut(app, "toggle");
    await expect(status).toContainText("Recording. Use the toggle shortcut or Stop to finish.");
    await expect.poll(() => server.attempts[1]?.length ?? 0).toBeGreaterThan(10);
    await shortcut(app, "cancel");
    await expect(status).toContainText("Cancelled.");
    await expect.poll(async () => (await snapshot(page)).session.recovery.length).toBe(1);
    expect(server.attempts).toHaveLength(2);
    const state = await snapshot(page);
    expect(JSON.stringify(state)).not.toContain("synthetic-fixture-key");
  } finally {
    if (appProcess.exitCode === null)
      await app.evaluate(({ app: application }) => application.exit(0)).catch(() => {});
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// Real-Mac proof: real Fn key events through the native tap, real Accessibility insertion into a
// scratch TextEdit document, synthetic audio, and a simulated provider. Opt in with
// VOICE_NATIVE_PROOF=1 on a Mac where the launching terminal holds Accessibility and Input
// Monitoring. CI runners have neither.
test("real TextEdit scratch target receives caret and selection insertion from real Fn key events", async () => {
  test.skip(!process.env.VOICE_NATIVE_PROOF, "Set VOICE_NATIVE_PROOF=1 on a prepared Mac.");
  test.setTimeout(240_000);
  await mkdir("test-results", { recursive: true });
  const tool = resolve("test-results/native-proof-tool");
  const source = resolve("tests/desktop/native-proof.swift");
  const [built, sourceInfo] = await Promise.all([stat(tool).catch(() => null), stat(source)]);
  if (!built || built.mtimeMs < sourceInfo.mtimeMs) await run("swiftc", ["-O", "-o", tool, source]);
  const osascript = (...lines: string[]) =>
    run(
      "osascript",
      lines.flatMap((line) => ["-e", line]),
    ).then((result) => result.stdout.trim());
  const documentText = () => osascript('tell application "TextEdit" to get text of front document');
  const activateTextEdit = async () => {
    await osascript('tell application "TextEdit" to activate');
    await expect
      .poll(() =>
        osascript(
          'tell application "System Events" to get name of first process whose frontmost is true',
        ),
      )
      .toBe("TextEdit");
  };
  const steps: Record<string, unknown>[] = [];
  const evidence: Record<string, unknown> = {
    generated: new Date().toISOString(),
    app: executablePath,
    commit: (await run("git", ["rev-parse", "HEAD"])).stdout.trim(),
    macOS: (await run("sw_vers", ["-productVersion"])).stdout.trim(),
    build: (await run("sw_vers", ["-buildVersion"])).stdout.trim(),
    hardware: (await run("sysctl", ["-n", "machdep.cpu.brand_string"])).stdout.trim(),
    textEdit: (
      await run("defaults", [
        "read",
        "/System/Applications/TextEdit.app/Contents/Info.plist",
        "CFBundleShortVersionString",
      ])
    ).stdout.trim(),
    provider:
      "simulated: loopback WebSocket fixture returning fixed provider-final text; no live Deepgram request",
    capture: "synthetic: helper-generated 440 Hz PCM16; the microphone was not opened",
    shortcuts: "real: CGEvents posted from the test process through the helper's session event tap",
    insertion: "real: Accessibility selected-text insertion by the packaged helper into TextEdit",
    permissions: "attributed to the launching terminal's Accessibility and Input Monitoring grants",
    steps,
  };
  const directory = await mkdtemp(join(tmpdir(), "voice-proof-"));
  const scratch = join(directory, "scratch.txt");
  await writeFile(scratch, "alpha omega");
  const server = await fixtureServer();
  const app = await launch(directory, server.url);
  const appProcess = app.process();
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("button", { name: "Start practice", exact: true })).toBeEnabled();
    await expect.poll(async () => (await snapshot(page)).status.shortcuts).toBe("listening");
    await run("open", ["-a", "TextEdit", scratch]);
    await activateTextEdit();
    const pid = Number(
      await osascript('tell application "System Events" to get unix id of process "TextEdit"'),
    );
    const key = (name: string, direction: "down" | "up") => run(tool, ["key", name, direction]);
    const session = async () => (await snapshot(page)).session;
    async function dictate() {
      await key("fn", "down");
      await expect.poll(async () => (await session()).phase).toBe("recording");
      await expect.poll(() => server.attempts.at(-1)?.length ?? 0).toBeGreaterThan(10);
    }
    async function finish() {
      await key("fn", "up");
      await expect
        .poll(async () => (await session()).phase, { timeout: 15_000 })
        .toMatch(/complete|failed/);
      return session();
    }
    // 1. Caret insertion at the start of the document.
    await run(tool, ["select", String(pid), "0", "0"]);
    await dictate();
    let result = await finish();
    let text = await documentText();
    steps.push({ step: "caret insertion at 0", message: result.message, document: text });
    expect(result.message).toBe("Inserted.");
    expect(text).toBe(`${transcript}alpha omega`);
    // 2. Selection replacement of "omega".
    const omega = text.indexOf("omega");
    await run(tool, ["select", String(pid), String(omega), "5"]);
    await dictate();
    result = await finish();
    text = await documentText();
    steps.push({ step: "selection replacement", message: result.message, document: text });
    expect(result.message).toBe("Inserted.");
    expect(text).toBe(`${transcript}alpha ${transcript}`);
    // 3. Focus leaves the original field during recording and returns: no automatic insertion.
    await dictate();
    await osascript('tell application "Finder" to activate');
    await activateTextEdit();
    result = await finish();
    const unchanged = await documentText();
    steps.push({
      step: "focus change during session",
      message: result.message,
      document: unchanged,
    });
    expect(result.message).toContain("Focus moved away");
    expect(unchanged).toBe(text);
    expect(result.recovery).toEqual([
      expect.objectContaining({ text: transcript, delivery: "failed" }),
    ]);
    // 4. Escape cancels a running session even while Fn stays held.
    await dictate();
    await key("escape", "down");
    await key("escape", "up");
    await expect.poll(async () => (await session()).phase).toBe("cancelled");
    await key("fn", "up");
    expect((await session()).phase).toBe("cancelled");
    steps.push({ step: "escape cancel", message: (await session()).message });
    // 5. Explicit Paste into a deliberately clicked TextEdit field.
    const entryId = result.recovery[0]?.id;
    if (!entryId) throw new Error("Expected a recovery entry to paste");
    await page.evaluate((id) => window.voice.command({ type: "recovery.paste", id }), entryId);
    await expect.poll(async () => (await session()).armedPaste).toBe(entryId);
    const bounds = (
      await osascript(
        'tell application "System Events" to tell process "TextEdit" to get {position, size} of window 1',
      )
    )
      .split(",")
      .map((value: string) => Number(value.trim()));
    const [x = 0, y = 0, width = 0, height = 0] = bounds;
    await run(tool, ["select", String(pid), String(text.length), "0"]);
    await run(tool, ["click", String(x + width / 2), String(y + height / 2)]);
    await expect.poll(async () => (await session()).recovery.length, { timeout: 15_000 }).toBe(0);
    const pasted = await documentText();
    steps.push({ step: "explicit paste after click", document: pasted });
    expect(pasted).toBe(`${text}${transcript}`);
    await page
      .getByRole("region", { name: "Temporary recovery" })
      .screenshot({ path: "test-results/dictation-proof-recovery.png" });
    evidence.result = "passed";
  } finally {
    await writeFile("test-results/native-proof.json", JSON.stringify(evidence, null, 2));
    await osascript('tell application "TextEdit" to close front document saving no').catch(
      () => {},
    );
    if (appProcess.exitCode === null)
      await app.evaluate(({ app: application }) => application.exit(0)).catch(() => {});
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

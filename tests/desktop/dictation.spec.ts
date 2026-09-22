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

type MenuItemState = { label: string; enabled: boolean; sublabel: string; type: string };
const menuItems = (app: ElectronApplication) =>
  app.evaluate(() =>
    (globalThis as unknown as { voiceTest: { menu: () => MenuItemState[] } }).voiceTest.menu(),
  );
const menuItem = async (app: ElectronApplication, label: string) =>
  (await menuItems(app)).find((item) => item.label === label);
// Invokes the click handler of the real menu-bar Menu item, only when it is enabled.
const menuClick = async (app: ElectronApplication, label: string) =>
  expect(
    await app.evaluate(
      (_electron, input) =>
        (
          globalThis as unknown as { voiceTest: { menuClick: (label: string) => boolean } }
        ).voiceTest.menuClick(input),
      label,
    ),
    `${label} in ${JSON.stringify(await menuItems(app))}`,
  ).toBe(true);
const panelWidth = (app: ElectronApplication) =>
  app.evaluate(
    () =>
      (
        globalThis as unknown as { voiceTest: { panelBounds: () => { width: number } } }
      ).voiceTest.panelBounds().width,
  );
// Counts repaints of each window while nothing happens; idle Voice should paint nothing.
// Subscribing delivers the current frame once, so frames from a short settle window are dropped.
const idleRepaints = (app: ElectronApplication, milliseconds: number) =>
  app.evaluate(async ({ BrowserWindow }, duration) => {
    const counts = BrowserWindow.getAllWindows().map((window) => {
      const count = { url: window.webContents.getURL(), frames: 0 };
      window.webContents.beginFrameSubscription(true, () => {
        count.frames += 1;
      });
      return { window, count };
    });
    await new Promise((done) => setTimeout(done, 500));
    for (const { count } of counts) count.frames = 0;
    await new Promise((done) => setTimeout(done, duration));
    for (const { window } of counts) window.webContents.endFrameSubscription();
    return counts.map(({ count }) => count);
  }, milliseconds);

test("packaged menu bar, floating bar, main window, and shortcut control one session", async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), "voice-entry-"));
  const server = await fixtureServer();
  const app = await launch(directory, server.url);
  const appProcess = app.process();
  try {
    const page = await app.firstWindow();
    const status = page.getByTestId("dictation-status");
    const dictation = page.getByRole("region", { name: "System-wide dictation" });
    await expect(page.getByRole("button", { name: "Start practice", exact: true })).toBeEnabled();
    const panel = await panelPage(app);
    const bar = panel.getByRole("status", { name: "Dictation status" });
    expect(await panelState(app)).toMatchObject({ visible: false });
    // After setup the bar docks in compact form. Setup completion never starts capture.
    await page.evaluate(() =>
      window.voice.command({
        type: "setup.save",
        inputDevice: null,
        shortcuts: { hold: "Fn", toggle: "Fn+Space", cancel: "Escape" },
        completed: true,
      }),
    );
    await expect.poll(async () => (await panelState(app)).visible).toBe(true);
    expect(await panelWidth(app)).toBe(112);
    expect(await panelState(app)).toMatchObject({ focusable: false, focused: false });
    expect(server.attempts).toHaveLength(0);
    await panel.screenshot({ path: "test-results/entry-bar-compact.png" });
    // Every session below starts with Voice frontmost, so it has no external target. If another
    // app took focus anyway, cancel before delivery so no text reaches it, and fail.
    const front = async () => {
      await app.evaluate(({ app: application }) => application.focus({ steal: true }));
      await expect.poll(async () => (await panelState(app)).mainFocused).toBe(true);
    };
    const withoutTarget = async () => {
      try {
        await expect(status).toContainText("The transcript will go to recovery.");
      } catch (error) {
        await page.evaluate(() => window.voice.command({ type: "session.cancel" }));
        throw error;
      }
    };
    await front();
    const idle = await idleRepaints(app, 1_500);
    expect(idle.map(({ frames }) => frames)).toEqual(idle.map(() => 0));
    expect(await menuItems(app)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Ready", enabled: false }),
        expect.objectContaining({ label: "Start dictation", enabled: true }),
        expect.objectContaining({ label: "Stop", enabled: false }),
        expect.objectContaining({ label: "Cancel", enabled: false }),
        expect.objectContaining({
          label: "Copy last transcript",
          enabled: false,
          sublabel: "No transcript is held.",
        }),
        expect.objectContaining({ label: "Open recovery", enabled: true }),
      ]),
    );

    // 1. Menu Start, then floating-bar Stop.
    await menuClick(app, "Start dictation");
    await withoutTarget();
    await expect(bar.getByTestId("panel-status")).toContainText("Recording");
    expect(await panelWidth(app)).toBe(480);
    expect(await panelState(app)).toMatchObject({ visible: true, focused: false });
    expect(await menuItem(app, "Start dictation")).toMatchObject({
      enabled: false,
      sublabel: "A session is already in progress.",
    });
    expect(await menuItem(app, "Recording")).toMatchObject({ enabled: false });
    await expect.poll(() => server.attempts[0]?.length ?? 0).toBeGreaterThan(10);
    await panel.screenshot({ path: "test-results/entry-bar-recording.png" });
    await bar.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(status).toContainText("Not inserted.");
    await expect(bar.getByTestId("panel-status")).toContainText("Not inserted.");
    await panel.screenshot({ path: "test-results/entry-bar-not-inserted.png" });
    const first = (await snapshot(page)).session;
    expect(first).toMatchObject({
      notice: "not-inserted",
      recovery: [expect.objectContaining({ text: transcript, delivery: "failed" })],
    });
    expect(first.lastTranscript).toBe(first.recovery[0]?.id);
    expect(await menuItem(app, "Open recovery (1 of 5)")).toMatchObject({ enabled: true });
    expect(await menuItem(app, "Paste last transcript")).toMatchObject({ enabled: true });
    // The bar's repair action opens recovery in the main window.
    await bar.getByRole("button", { name: "Open recovery" }).click();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id))
      .toBe("section-recovery");

    // 2. Main-window Start, then menu Cancel.
    await front();
    await dictation.getByRole("button", { name: "Start dictation" }).click();
    await withoutTarget();
    await expect.poll(() => server.attempts[1]?.length ?? 0).toBeGreaterThan(10);
    await menuClick(app, "Cancel");
    await expect(status).toContainText("Cancelled.");
    await expect(dictation.getByRole("button", { name: "Start dictation" })).toBeEnabled();

    // 3. Shortcut Start, then floating-bar Cancel.
    await front();
    await shortcut(app, "hold.down");
    await withoutTarget();
    await expect(bar.getByTestId("panel-status")).toContainText("Recording");
    await expect.poll(() => server.attempts[2]?.length ?? 0).toBeGreaterThan(0);
    await bar.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(status).toContainText("Cancelled.");
    await shortcut(app, "hold.up");
    expect(server.attempts).toHaveLength(3);

    // 4. Floating-bar Start, then Open recovery from the menu while processing.
    await expect(bar.getByRole("button", { name: "Start dictation" })).toBeEnabled();
    await front();
    await bar.getByRole("button", { name: "Start dictation" }).click();
    await withoutTarget();
    await expect.poll(() => server.attempts[3]?.length ?? 0).toBeGreaterThan(10);
    await bar.getByRole("button", { name: "Stop", exact: true }).click();
    await menuClick(app, "Open recovery (1 of 5)");
    await expect(status).toContainText("Not inserted.");
    const second = (await snapshot(page)).session;
    expect(second.recovery).toHaveLength(2);
    expect(second.lastTranscript).toBe(second.recovery[1]?.id);

    // 5. Paste last transcript arms the newest entry; menu Cancel paste disarms it.
    await menuClick(app, "Paste last transcript");
    await expect
      .poll(async () => (await snapshot(page)).session.armedPaste)
      .toBe(second.lastTranscript);
    await expect(bar.getByTestId("panel-status")).toContainText("Paste:");
    expect(await menuItem(app, "Start dictation")).toMatchObject({
      enabled: false,
      sublabel: "A paste is waiting for you to choose a field.",
    });
    await menuClick(app, "Cancel paste");
    await expect(page.getByTestId("recovery-status")).toContainText("Paste cancelled");
    await expect.poll(() => panelWidth(app), { timeout: 10_000 }).toBe(112);
    expect(server.attempts).toHaveLength(4);
  } finally {
    if (appProcess.exitCode === null)
      await app.evaluate(({ app: application }) => application.exit(0)).catch(() => {});
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// Shared by the opt-in real-Mac proofs below.
async function proofTool() {
  await mkdir("test-results", { recursive: true });
  const tool = resolve("test-results/native-proof-tool");
  const source = resolve("tests/desktop/native-proof.swift");
  const [built, sourceInfo] = await Promise.all([stat(tool).catch(() => null), stat(source)]);
  if (!built || built.mtimeMs < sourceInfo.mtimeMs) await run("swiftc", ["-O", "-o", tool, source]);
  return tool;
}
const osascript = (...lines: string[]) =>
  run(
    "osascript",
    lines.flatMap((line) => ["-e", line]),
  ).then((result) => result.stdout.trim());
const frontmost = async () =>
  (await run(resolve("test-results/native-proof-tool"), ["frontmost"])).stdout.trim();
async function activateTextEdit() {
  await osascript('tell application "TextEdit" to activate');
  await expect.poll(frontmost).toBe("TextEdit");
}
async function proofEnvironment() {
  return {
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
    insertion: "real: Accessibility selected-text insertion by the packaged helper into TextEdit",
    permissions: "attributed to the launching terminal's Accessibility and Input Monitoring grants",
  };
}

// Real-Mac proof: real Fn key events through the native tap, real Accessibility insertion into a
// scratch TextEdit document, synthetic audio, and a simulated provider. Opt in with
// VOICE_NATIVE_PROOF=1 on a Mac where the launching terminal holds Accessibility and Input
// Monitoring. CI runners have neither.
test("real TextEdit scratch target receives caret and selection insertion from real Fn key events", async () => {
  test.skip(!process.env.VOICE_NATIVE_PROOF, "Set VOICE_NATIVE_PROOF=1 on a prepared Mac.");
  test.setTimeout(240_000);
  const tool = await proofTool();
  const documentText = () => osascript('tell application "TextEdit" to get text of front document');
  const steps: Record<string, unknown>[] = [];
  const evidence: Record<string, unknown> = {
    ...(await proofEnvironment()),
    shortcuts: "real: CGEvents posted from the test process through the helper's session event tap",
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
    // The floating bar takes over clicks on itself, so the destination click must miss it.
    const bar = await app.evaluate(() =>
      (
        globalThis as unknown as {
          voiceTest: { panelBounds: () => { x: number; y: number; width: number; height: number } };
        }
      ).voiceTest.panelBounds(),
    );
    const [clickX, clickY] = [x + width / 2, y + height / 2];
    expect(
      clickX >= bar.x &&
        clickX < bar.x + bar.width &&
        clickY >= bar.y &&
        clickY < bar.y + bar.height,
    ).toBe(false);
    await run(tool, ["click", String(clickX), String(clickY)]);
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

// Real-Mac proof for the floating bar and menu bar: real mouse clicks on the non-activating bar
// and on the native menu-bar menu keep TextEdit frontmost, so the session inserts into the field
// focused at Start. Opening recovery moves focus to Voice and keeps that session's transcript.
// A secure-input dialog hides Escape from the event tap; the bar's Cancel still stops capture.
// Same opt-in and permission requirements as the proof above.
test("real clicks on the floating bar and menu bar keep TextEdit focused and insert there", async () => {
  test.skip(!process.env.VOICE_NATIVE_PROOF, "Set VOICE_NATIVE_PROOF=1 on a prepared Mac.");
  test.setTimeout(240_000);
  const tool = await proofTool();
  const documentText = () => osascript('tell application "TextEdit" to get text of front document');
  const steps: Record<string, unknown>[] = [];
  const evidence: Record<string, unknown> = {
    ...(await proofEnvironment()),
    controls:
      "real: CGEvent mouse clicks on the floating bar and on the menu-bar icon and menu items",
    steps,
  };
  const directory = await mkdtemp(join(tmpdir(), "voice-entry-proof-"));
  const scratch = join(directory, "scratch.txt");
  await writeFile(scratch, "alpha omega");
  const server = await fixtureServer();
  const app = await launch(directory, server.url);
  const appProcess = app.process();
  let dialog: ReturnType<typeof execFile> | undefined;
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("button", { name: "Start practice", exact: true })).toBeEnabled();
    await expect.poll(async () => (await snapshot(page)).status.shortcuts).toBe("listening");
    await page.evaluate(() =>
      window.voice.command({
        type: "setup.save",
        inputDevice: null,
        shortcuts: { hold: "Fn", toggle: "Fn+Space", cancel: "Escape" },
        completed: true,
      }),
    );
    const panel = await panelPage(app);
    const bar = panel.getByRole("status", { name: "Dictation status" });
    await expect.poll(async () => (await panelState(app)).visible).toBe(true);
    await run("open", ["-a", "TextEdit", scratch]);
    await activateTextEdit();
    const pid = Number(
      await osascript('tell application "System Events" to get unix id of process "TextEdit"'),
    );
    const voice = await osascript(
      `tell application "System Events" to get name of first process whose unix id is ${appProcess.pid}`,
    );
    const session = async () => (await snapshot(page)).session;
    const hooks = <T>(name: "panelBounds" | "trayBounds") =>
      app.evaluate(
        (_electron, hook) =>
          (globalThis as unknown as { voiceTest: Record<string, () => T> }).voiceTest[hook]?.(),
        name,
      );
    type Bounds = { x: number; y: number; width: number; height: number };
    const click = (x: number, y: number) => run(tool, ["click", String(x), String(y)]);
    // A real click at the center of a bar control, located from the live panel bounds.
    async function clickBar(name: string) {
      const button = bar.getByRole("button", { name, exact: true });
      await expect(button).toBeEnabled();
      const box = await button.boundingBox();
      const bounds = await hooks<Bounds>("panelBounds");
      if (!box || !bounds) throw new Error(`Missing ${name} bounds`);
      await click(bounds.x + box.x + box.width / 2, bounds.y + box.y + box.height / 2);
    }
    const frame = async (element: string) => {
      const [x = 0, y = 0, width = 0, height = 0] = (
        await osascript(
          `tell application "System Events" to tell process "${voice}" to get {position, size} of ${element}`,
        )
      )
        .split(",")
        .map((value: string) => Number(value.trim()));
      if (!(width > 0 && height > 0)) throw new Error(`Invalid bounds for ${element}`);
      return { x, y, width, height };
    };
    // A real click on the menu-bar icon, then a real click on the named item of its open menu.
    // `capture` saves only the open menu's rectangle as evidence.
    async function clickMenu(label: string, capture?: string) {
      const tray = await hooks<Bounds>("trayBounds");
      if (!tray || tray.y > 5 || tray.height < 10) throw new Error("Missing menu-bar icon");
      await click(tray.x + tray.width / 2, tray.y + tray.height / 2);
      const menu = "menu 1 of menu bar item 1 of menu bar 2";
      if (capture) {
        const { x, y, width, height } = await frame(menu);
        await run("screencapture", ["-x", `-R${x},${y},${width},${height}`, capture]);
      }
      const { x, y, width, height } = await frame(`menu item "${label}" of ${menu}`);
      await click(x + width / 2, y + height / 2);
    }
    const recording = async () => {
      await expect.poll(async () => (await session()).phase).toBe("recording");
      await expect.poll(() => server.attempts.at(-1)?.length ?? 0).toBeGreaterThan(10);
    };
    const finished = async () => {
      await expect
        .poll(async () => (await session()).phase, { timeout: 15_000 })
        .toMatch(/complete|failed|cancelled/);
      return session();
    };
    let text = await documentText();

    // 1. Floating bar Start and Stop with TextEdit focused.
    await run(tool, ["select", String(pid), String(text.length), "0"]);
    await clickBar("Start dictation");
    await recording();
    const barFront = await frontmost();
    expect((await session()).message).toBe("Recording. Use the toggle shortcut or Stop to finish.");
    await panel.screenshot({ path: "test-results/entry-proof-bar-recording.png" });
    await clickBar("Stop");
    let result = await finished();
    const afterBar = await documentText();
    steps.push({
      step: "floating bar Start then Stop",
      frontmostWhileRecording: barFront,
      message: result.message,
      document: afterBar,
    });
    expect(barFront).toBe("TextEdit");
    expect(result.message).toBe("Inserted.");
    expect(afterBar).toBe(`${text}${transcript}`);
    text = afterBar;

    // 2. Menu-bar Start and Stop with TextEdit focused.
    await clickMenu("Start dictation");
    await recording();
    const menuFront = await frontmost();
    await clickMenu("Stop", "test-results/entry-proof-menu-recording.png");
    result = await finished();
    const afterMenu = await documentText();
    steps.push({
      step: "menu bar Start then Stop",
      frontmostWhileRecording: menuFront,
      message: result.message,
      document: afterMenu,
    });
    expect(menuFront).toBe("TextEdit");
    expect(result.message).toBe("Inserted.");
    expect(afterMenu).toBe(`${text}${transcript}`);
    text = afterMenu;

    // 3. Open recovery from the menu while recording: Voice comes forward, so no insertion.
    await activateTextEdit();
    await clickMenu("Start dictation");
    await recording();
    await clickMenu("Open recovery");
    await expect.poll(frontmost).toBe(voice);
    await clickBar("Stop");
    result = await finished();
    const afterRecovery = await documentText();
    steps.push({
      step: "menu Open recovery while recording, then bar Stop",
      message: result.message,
      document: afterRecovery,
    });
    expect(result.message).toContain("Focus moved away");
    expect(afterRecovery).toBe(text);
    expect(result.recovery).toEqual([
      expect.objectContaining({ text: transcript, delivery: "failed" }),
    ]);

    // 4. Secure input hides Escape from the tap; the bar's clickable Cancel still stops capture.
    dialog = execFile("osascript", [
      "-e",
      'display dialog "Voice proof: secure field" default answer "" with hidden answer',
    ]);
    await expect
      .poll(() => run(tool, ["secure"]).then((output) => output.stdout.trim()))
      .toBe("on");
    await clickBar("Start dictation");
    await recording();
    await run(tool, ["key", "escape", "down"]);
    await run(tool, ["key", "escape", "up"]);
    const afterEscape = (await session()).phase;
    await clickBar("Cancel");
    result = await finished();
    steps.push({
      step: "secure input: Escape, then bar Cancel",
      phaseAfterEscape: afterEscape,
      message: result.message,
    });
    expect(afterEscape).toBe("recording");
    expect(result.phase).toBe("cancelled");
    evidence.result = "passed";
  } finally {
    dialog?.kill();
    await writeFile("test-results/entry-proof.json", JSON.stringify(evidence, null, 2));
    await osascript('tell application "TextEdit" to close front document saving no').catch(
      () => {},
    );
    if (appProcess.exitCode === null)
      await app.evaluate(({ app: application }) => application.exit(0)).catch(() => {});
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

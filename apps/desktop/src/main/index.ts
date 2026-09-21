import { app, BrowserWindow, ipcMain, session, net, type IpcMainInvokeEvent } from "electron";
import { createSession } from "./session";
import { createProvider } from "./provider";
import { createHash } from "node:crypto";
import { createSetup } from "./setup";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { defaultSettings, commandChannel, type Status } from "@voice/contracts/desktop";
import { launchHelper } from "@voice/platform/macos";
import { createCommands } from "./commands";
import { StorageWorker } from "./storage";
import { dataDirectory } from "./data-directory";

const testDirectory = process.argv
  .find((argument) => argument.startsWith("--voice-test-data="))
  ?.slice("--voice-test-data=".length);
const devUrl = !app.isPackaged ? process.env.VOICE_DEV_URL : undefined;
// Unsigned development packages also use development storage by default.
app.setPath(
  "userData",
  dataDirectory(app.getPath("appData"), testDirectory ? "test" : "development", testDirectory),
);
app.setName(testDirectory ? "Voice Test" : "Voice Development");
const renderer = pathToFileURL(join(__dirname, "../renderer/index.html")).href;
const expectedUrl = devUrl ?? renderer;
if (devUrl && !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(devUrl))
  throw new Error("Invalid development server");
let window: BrowserWindow | undefined;
export let helper: ReturnType<typeof launchHelper> | undefined;
let helperState: Status["helper"] = "starting";
let closing = false;
export let storage: StorageWorker;
function notify() {
  if (window && !window.isDestroyed()) window.webContents.send("voice:changed");
}
const commands = createCommands<IpcMainInvokeEvent>({
  setup: () => setup,
  session: () => practice,
  initialSettings: defaultSettings,
  isAuthorized: (event) =>
    !!window &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame.url === expectedUrl,
  storage: { set: (settings) => storage.set(settings), restart: () => storage.restart() },
  status: () => ({
    storage: storage?.state ?? "starting",
    helper: helperState,
    capture: practice.snapshot().phase === "recording" ? "active" : setup.snapshot().localCapture,
  }),
});
export const setup = createSetup({
  native: (command) => {
    if (!helper) return Promise.reject(new Error("native-unavailable"));
    return helper.request(command);
  },
  preferences: commands.preferences,
  save: commands.saveSetup,
  connectivity: () => (net.isOnline() ? "online" : "offline"),
  credentialChanged: () => notify(),
});
// Test capture and endpoint must be opted into together, with isolated storage and Keychain.
const fixtureUrl =
  testDirectory && process.env.VOICE_TEST_CAPTURE === "synthetic"
    ? process.env.VOICE_TEST_PROVIDER_URL
    : undefined;
const provider = createProvider(
  join(__dirname, "provider-worker.cjs"),
  (event) => practice.providerEvent(event),
  fixtureUrl,
);
export const practice = createSession({
  available: () =>
    helperState === "ready" &&
    storage?.state === "ready" &&
    (!!fixtureUrl || setup.snapshot().blockers.length === 0),
  device: () => commands.preferences().inputDevice,
  credential: () => helper?.credential() ?? Promise.reject(new Error("native-unavailable")),
  capture: (command) => {
    if (!helper) throw new Error("native-unavailable");
    helper.capture(command);
  },
  provider: (command) => provider.send(command),
  changed: notify,
  access: (reason) => {
    if (reason === "authenticated") setup.updateAccess("authenticated", "available");
    else if (reason === "rejected") setup.updateAccess("rejected", "unknown");
    else
      setup.updateAccess(
        setup.snapshot().credential.verification,
        reason === "quota" ? "quota-exhausted" : "rate-limited",
      );
    notify();
  },
});
ipcMain.handle(commandChannel, async (event, payload: unknown) => {
  const reply = await commands.execute(event, payload);
  return reply;
});

async function createWindow() {
  window = new BrowserWindow({
    width: 820,
    height: 820,
    minWidth: 560,
    minHeight: 440,
    title: "Voice",
    backgroundColor: "#f3f6fa",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.on("render-process-gone", () =>
    practice.interrupted("The practice window stopped. Available work remains in memory."),
  );
  window.webContents.on("did-start-loading", () =>
    practice.interrupted("The practice window reloaded. Available work remains in memory."),
  );
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  await window.loadURL(expectedUrl);
}

app
  .whenReady()
  .then(async () => {
    await mkdir(app.getPath("userData"), { recursive: true });
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed =
        details.url.startsWith("file:") ||
        (devUrl && new URL(details.url).host === new URL(devUrl).host);
      callback({ cancel: !allowed });
    });
    storage = new StorageWorker(
      {
        entry: join(__dirname, "storage-worker.cjs"),
        filename: join(app.getPath("userData"), "settings.sqlite"),
        migrations: join(__dirname, "../migrations"),
      },
      notify,
    );
    helper = launchHelper(
      app.isPackaged
        ? join(process.resourcesPath, "app.asar.unpacked/native/voice-helper")
        : join(__dirname, "../native/voice-helper"),
      () => {
        helperState = "failed";
        setup.unavailable();
        practice.helperFailed();
        notify();
      },
      testDirectory
        ? `com.codlume.voice.test.${createHash("sha256").update(app.getPath("userData")).digest("hex")}`
        : undefined,
      (event) => practice.captureEvent(event),
      !!fixtureUrl,
    );
    void helper.ready.then(
      () => {
        helperState = "ready";
        notify();
      },
      () => {
        helperState = "failed";
        setup.unavailable();
        practice.helperFailed();
        notify();
      },
    );
    const storageReady = storage.start();
    void storageReady.then(
      (settings) => {
        commands.updateSettings(settings);
        notify();
      },
      () => notify(),
    );
    if (closing) return;
    await createWindow();
    void Promise.all([helper.ready, storageReady]).then(
      async () => {
        await setup.refresh().catch(() => {});
        notify();
        process.send?.({
          type: "ready",
          pid: process.pid,
          helperPid: helper?.child.pid,
          capture: "unavailable",
        });
      },
      () => process.send?.({ type: "startup-failed" }),
    );
  })
  .catch(() => {
    app.quit();
  });

app.on("activate", () => {
  if (!closing && BrowserWindow.getAllWindows().length === 0) void createWindow();
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (closing) return;
  event.preventDefault();
  closing = true;
  practice.close();
  void Promise.allSettled([storage?.close(), helper?.close(), provider.close()]).then(() =>
    app.quit(),
  );
});
process.on("SIGTERM", () => app.quit());
process.on("SIGINT", () => app.quit());

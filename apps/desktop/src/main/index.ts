import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  screen,
  session,
  net,
  type IpcMainInvokeEvent,
} from "electron";
import { createSession } from "./session";
import { createProvider } from "./provider";
import { createHash } from "node:crypto";
import { createSetup } from "./setup";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { defaultSettings, commandChannel, type Status } from "@voice/contracts/desktop";
import { decodeShortcutEvent } from "@voice/contracts/session";
import {
  decodeNativeSetupResult,
  type NativeSetupCommand,
  type NativeSetupResult,
} from "@voice/contracts/setup";
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
const panelUrl = `${expectedUrl}?view=status`;
if (devUrl && !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(devUrl))
  throw new Error("Invalid development server");
let window: BrowserWindow | undefined;
let panel: BrowserWindow | undefined;
let panelHide: ReturnType<typeof setTimeout> | undefined;
let panelSync: ReturnType<typeof setImmediate> | undefined;
let panelShown = "";
export let helper: ReturnType<typeof launchHelper> | undefined;
let helperState: Status["helper"] = "starting";
let shortcutState: Status["shortcuts"] = "unavailable";
let engaged = false;
let closing = false;
let quitConfirmed = false;
export let storage: StorageWorker;
const webPreferences = {
  preload: join(__dirname, "preload.cjs"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};
function notify() {
  for (const target of [window, panel])
    if (target && !target.isDestroyed()) target.webContents.send("voice:changed");
  // Window presentation stays off the shortcut and capture path.
  panelSync ??= setImmediate(() => {
    panelSync = undefined;
    syncPanel();
  });
}
async function request<Kind extends NativeSetupResult["type"]>(
  command: NativeSetupCommand,
  kind: Kind,
): Promise<Extract<NativeSetupResult, { type: Kind }>> {
  if (!helper) throw new Error("native-unavailable");
  const result = decodeNativeSetupResult(await helper.request(command));
  if (result.type !== kind) throw new Error("native-unavailable");
  return result as Extract<NativeSetupResult, { type: Kind }>;
}
// The helper holds the full desired shortcut state, so a restart or setup change resends it.
async function syncShortcuts() {
  if (!helper || helperState !== "ready") return;
  try {
    const result = await request(
      { type: "shortcut.configure", shortcuts: commands.preferences().shortcuts, active: engaged },
      "shortcuts",
    );
    shortcutState = result.listening ? "listening" : "unavailable";
  } catch {
    shortcutState = "unavailable";
  }
  notify();
}
const commands = createCommands<IpcMainInvokeEvent>({
  quit: (confirmed) => {
    quitConfirmed = confirmed;
    app.quit();
  },
  setup: () => setup,
  session: () => dictation,
  initialSettings: defaultSettings,
  isAuthorized: (event) =>
    [
      [window, expectedUrl],
      [panel, panelUrl],
    ].some(
      ([target, url]) =>
        target instanceof BrowserWindow &&
        !target.isDestroyed() &&
        event.sender === target.webContents &&
        event.senderFrame === target.webContents.mainFrame &&
        event.senderFrame.url === url,
    ),
  permitted: (event, command) => event.sender !== panel?.webContents || command === "status.get",
  storage: { set: (settings) => storage.set(settings), restart: () => storage.restart() },
  status: () => ({
    storage: storage?.state ?? "starting",
    helper: helperState,
    capture: dictation.snapshot().phase === "recording" ? "active" : setup.snapshot().localCapture,
    shortcuts: shortcutState,
  }),
});
export const setup = createSetup({
  native: (command) =>
    helper ? helper.request(command) : Promise.reject(new Error("native-unavailable")),
  preferences: commands.preferences,
  save: async (preferences) => {
    await commands.saveSetup(preferences);
    void syncShortcuts();
  },
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
  (event) => dictation.providerEvent(event),
  fixtureUrl,
);
export const dictation = createSession({
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
  copy: async (text) => {
    await clipboard.writeText(text);
    return (await clipboard.readText()) === text;
  },
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
  target: {
    capture: async (id) =>
      (await request({ type: "target.capture", session: id }, "target")).status,
    arm: async (id) => {
      await request({ type: "target.arm", session: id }, "armed");
    },
    insert: async (id, text) =>
      (await request({ type: "target.insert", session: id, text }, "insertion")).outcome,
    release: (id) => {
      void request({ type: "target.release", session: id }, "released").catch(() => {});
    },
  },
  engaged: (active) => {
    engaged = active;
    void syncShortcuts();
  },
});
export const practice = dictation;
if (testDirectory) {
  // Packaged tests drive the shortcut path without a native key tap. The real-key proof is separate.
  Object.assign(globalThis, {
    voiceTest: {
      shortcut: (action: unknown) =>
        dictation.shortcut(decodeShortcutEvent({ type: "shortcut", action }).action),
    },
  });
}
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
    webPreferences,
  });
  window.on("close", (event) => {
    if (closing) return;
    event.preventDefault();
    dictation.practiceInterrupted("The practice window closed. Available work remains in memory.");
    window?.hide();
  });
  window.webContents.on("render-process-gone", () =>
    dictation.practiceInterrupted("The practice window stopped. Available work remains in memory."),
  );
  window.webContents.on("did-start-loading", () =>
    dictation.practiceInterrupted(
      "The practice window reloaded. Available work remains in memory.",
    ),
  );
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  await window.loadURL(expectedUrl);
}
// A non-activating panel keeps the external target focused while it shows session status.
async function createPanel() {
  panel = new BrowserWindow({
    width: 420,
    height: 84,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    backgroundColor: "#172b45",
    title: "Voice status",
    type: "panel",
    webPreferences,
  });
  panel.setAlwaysOnTop(true, "floating");
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panel.on("close", (event) => {
    if (!closing) event.preventDefault();
  });
  panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  panel.webContents.on("will-navigate", (event) => event.preventDefault());
  panel.webContents.on("render-process-gone", () => {
    if (!closing && panel && !panel.isDestroyed()) panel.webContents.reload();
  });
  await panel.loadURL(panelUrl);
}
function syncPanel() {
  const current = panel;
  if (!current || current.isDestroyed() || closing) return;
  const snapshot = dictation.snapshot();
  const busy =
    ["starting", "recording", "processing", "inserting"].includes(snapshot.phase) ||
    snapshot.armedPaste !== null;
  const external = snapshot.origin === "dictation" || snapshot.armedPaste !== null;
  // Any new outcome from a shortcut session flashes briefly, including a refused start.
  const shown = `${snapshot.phase}\n${snapshot.message}\n${snapshot.armedPaste ?? ""}`;
  const changed = shown !== panelShown;
  panelShown = shown;
  if (external && (busy || changed)) {
    clearTimeout(panelHide);
    panelHide = undefined;
    if (!current.isVisible()) {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const { x, y, width, height } = display.workArea;
      const [panelWidth, panelHeight] = current.getSize();
      current.setPosition(
        Math.round(x + (width - (panelWidth ?? 0)) / 2),
        Math.round(y + height - (panelHeight ?? 0) - 24),
      );
      current.showInactive();
    }
    if (busy) return;
  }
  if (current.isVisible() && !panelHide) {
    panelHide = setTimeout(() => {
      panelHide = undefined;
      if (!current.isDestroyed()) current.hide();
    }, 2_500);
  }
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
    const failedHelper = () => {
      helperState = "failed";
      shortcutState = "unavailable";
      setup.unavailable();
      dictation.helperFailed();
      notify();
    };
    helper = launchHelper(
      app.isPackaged
        ? join(process.resourcesPath, "app.asar.unpacked/native/voice-helper")
        : join(__dirname, "../native/voice-helper"),
      failedHelper,
      {
        testKeychainService: testDirectory
          ? `com.codlume.voice.test.${createHash("sha256").update(app.getPath("userData")).digest("hex")}`
          : undefined,
        syntheticCapture: !!fixtureUrl,
        captureEvent: (event) => dictation.captureEvent(event),
        shortcut: (event) => dictation.shortcut(event.action),
        targetSelected: (event) => dictation.targetSelected(event),
      },
    );
    void helper.ready.then(() => {
      helperState = "ready";
      notify();
    }, failedHelper);
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
    await createPanel();
    void Promise.all([helper.ready, storageReady]).then(
      async () => {
        await setup.refresh().catch(() => {});
        await syncShortcuts();
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

async function showWindow() {
  const current = window;
  if (!current || current.isDestroyed()) {
    await createWindow();
    return;
  }
  if (current.webContents.isCrashed()) {
    current.destroy();
    await createWindow();
    return;
  }
  current.show();
  current.focus();
}
app.on("activate", () => {
  if (!closing) void showWindow();
});
app.on("window-all-closed", () => {});
app.on("before-quit", (event) => {
  if (closing) return;
  event.preventDefault();
  if (!quitConfirmed && dictation.requestQuit()) {
    void showWindow();
    return;
  }
  closing = true;
  clearTimeout(panelHide);
  dictation.close();
  if (panel && !panel.isDestroyed()) panel.destroy();
  void Promise.allSettled([storage?.close(), helper?.close(), provider.close()]).then(() =>
    app.quit(),
  );
});
process.on("SIGTERM", () => app.quit());
process.on("SIGINT", () => app.quit());

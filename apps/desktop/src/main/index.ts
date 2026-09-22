import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  net,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import { createSession } from "./session";
import { createProvider } from "./provider";
import { createHash } from "node:crypto";
import { createSetup } from "./setup";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import {
  defaultSettings,
  commandChannel,
  revealChannel,
  type Settings,
  type Status,
  type View,
} from "@voice/contracts/desktop";
import { decodeShortcutEvent, type BarPointerEvent } from "@voice/contracts/session";
import {
  decodeNativeSetupResult,
  type NativeSetupCommand,
  type NativeSetupResult,
} from "@voice/contracts/setup";
import { launchHelper } from "@voice/platform/macos";
import { createCommands, floatingBarPermits } from "./commands";
import { StorageWorker } from "./storage";
import { dataDirectory } from "./data-directory";
import { menuEntries, type MenuEntry } from "./menu-bar";

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
let panelTimer: ReturnType<typeof setTimeout> | undefined;
let presentation: ReturnType<typeof setImmediate> | undefined;
let panelShown = "";
let outcomeUntil = 0;
let tray: Tray | undefined;
let trayMenu: Menu | undefined;
let trayRecording: boolean | undefined;
let trayShown = "";
export let helper: ReturnType<typeof launchHelper> | undefined;
let helperState: Status["helper"] = "starting";
let shortcutState: Status["shortcuts"] = "unavailable";
let engaged = false;
let closing = false;
let quitConfirmed = false;
export let storage: StorageWorker;
let storageReady: Promise<Settings> | undefined;
const webPreferences = {
  preload: join(__dirname, "preload.cjs"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};
function notify() {
  for (const target of [window, panel])
    if (target && !target.isDestroyed()) target.webContents.send("voice:changed");
  // Window and menu presentation stays off the shortcut and capture path.
  presentation ??= setImmediate(() => {
    presentation = undefined;
    syncPanel();
    syncTray();
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
// The helper holds the full desired event-tap state, so a restart or any change resends it.
async function syncShortcuts() {
  if (!helper || helperState !== "ready") return;
  try {
    const result = await request(
      {
        type: "shortcut.configure",
        shortcuts: commands.preferences().shortcuts,
        active: engaged,
        bar: barRegion(),
      },
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
  open: (view) => void openView(view),
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
  permitted: (event, command) => event.sender !== panel?.webContents || floatingBarPermits(command),
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
let testOffline = false;
let testCaptureStarts = 0;
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
  transcribable: () =>
    helperState === "ready" && (!!fixtureUrl || setup.snapshot().credential.presence === "saved"),
  // Isolated tests drive connectivity through the test hook, never the machine's network state.
  online: () => (fixtureUrl ? !testOffline : net.isOnline()),
  device: () => commands.preferences().inputDevice,
  credential: () => helper?.credential() ?? Promise.reject(new Error("native-unavailable")),
  capture: (command) => {
    if (!helper) throw new Error("native-unavailable");
    helper.capture(command);
    if (testDirectory && command.type === "capture.start") testCaptureStarts++;
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
  // The menu hook reads and clicks the real menu-bar Menu; native menu clicks are proved separately.
  // The offline hook stands in for network state, and captureStarts counts microphone starts.
  Object.assign(globalThis, {
    voiceTest: {
      shortcut: (action: unknown) =>
        dictation.shortcut(decodeShortcutEvent({ type: "shortcut", action }).action),
      menu: () =>
        trayMenu?.items.map(({ label, enabled, sublabel, type }) => ({
          label,
          enabled,
          sublabel,
          type,
        })) ?? [],
      menuClick: (label: string) => {
        const item = trayMenu?.items.find((entry) => entry.label === label);
        if (!item?.enabled) return false;
        item.click();
        return true;
      },
      offline: (value: unknown) => {
        testOffline = value === true;
      },
      captureStarts: () => testCaptureStarts,
      // Subordinate faults, each confined to this isolated app: the helper process is killed as
      // if it crashed, the provider worker is ended the same way, and the helper's synthetic
      // capture is told to fail as a lost device or revoked permission would.
      helper: () => ({ state: helperState, pid: helper?.child.pid }),
      killHelper: () => helper?.child.kill("SIGKILL"),
      killProvider: () => provider.kill(),
      captureFailure: (reason: unknown) => {
        if (fixtureUrl && (reason === "device" || reason === "permission"))
          helper?.simulateCaptureFailure(reason);
      },
      panelBounds: () => panel?.getBounds(),
      trayBounds: () => tray?.getBounds(),
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
// The floating bar. It never takes focus, and its clicks arrive through replayBarPointer, so the
// external target stays focused while the user controls a session from it.
async function createPanel() {
  panel = new BrowserWindow({
    width: compactSize.width,
    height: compactSize.height,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    // The helper takes real clicks on the bar over and replays them, so they never activate
    // Voice. Without its event tap, a click still reaches the controls but activates Voice.
    acceptFirstMouse: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    backgroundColor: "#202e40",
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
// The floating bar stays docked in compact form after setup. It expands while a session or paste
// runs, briefly for a dictation outcome, and while setup or recovery blocks Start. Before setup
// it appears only for shortcut dictation. Nothing animates, so an idle bar repaints nothing.
function syncPanel(reposition = false) {
  const current = panel;
  if (!current || current.isDestroyed() || closing) return;
  const snapshot = dictation.snapshot();
  const busy =
    ["starting", "recording", "processing", "inserting"].includes(snapshot.phase) ||
    snapshot.armedPaste !== null;
  const external = snapshot.origin === "dictation" || snapshot.armedPaste !== null;
  // Any new outcome from a dictation session shows briefly, including a refused start, and so
  // does a Copy or Paste outcome, which the menu has no other place to report.
  const recovery = snapshot.lastUpdate === "recovery";
  const shown = `${snapshot.phase}\n${snapshot.message}\n${snapshot.armedPaste ?? ""}\n${
    recovery ? snapshot.recoveryMessage : ""
  }`;
  if (shown !== panelShown && (external || recovery) && !busy) outcomeUntil = Date.now() + 2_500;
  panelShown = shown;
  const docked = commands.preferences().completed;
  const blocked = snapshot.blocker === "setup" || snapshot.blocker === "recovery-full";
  const size =
    (busy && (external || docked)) || Date.now() < outcomeUntil || (docked && blocked)
      ? expandedSize
      : docked
        ? compactSize
        : undefined;
  clearTimeout(panelTimer);
  panelTimer = undefined;
  if (Date.now() < outcomeUntil)
    panelTimer = setTimeout(() => syncPanel(), outcomeUntil - Date.now());
  if (!size) {
    if (current.isVisible()) current.hide();
    syncBarRegion();
    return;
  }
  const bounds = current.getBounds();
  if (!current.isVisible() || reposition || bounds.width !== size.width) {
    // Anchor the bar to the bottom center of the display it is on, or the pointer's display.
    const display = current.isVisible()
      ? screen.getDisplayMatching(bounds)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y, width, height } = display.workArea;
    current.setBounds({
      x: Math.round(x + (width - size.width) / 2),
      y: Math.round(y + height - size.height - 24),
      ...size,
    });
  }
  if (!current.isVisible()) current.showInactive();
  syncBarRegion();
}
let barShown = "";
function syncBarRegion() {
  const region = JSON.stringify(barRegion());
  if (region === barShown) return;
  barShown = region;
  void syncShortcuts();
}
// Both bar sizes share a bottom-center anchor, so the expanded footprint covers the bar before
// and after a resize and the helper's copy never lags behind it. The helper takes a click over
// only when the bar's own window is topmost at that point.
function barRegion() {
  if (!panel || panel.isDestroyed() || !panel.isVisible()) return null;
  const windowId = Number(panel.getMediaSourceId().split(":")[1]);
  if (!Number.isInteger(windowId) || windowId <= 0) return null;
  const { x, y, width, height } = panel.getBounds();
  return {
    x: Math.round(x + width / 2 - expandedSize.width / 2),
    y: y + height - expandedSize.height,
    ...expandedSize,
    window: windowId,
  };
}
// A real click the helper took over from the floating bar. Replaying it into the web contents,
// rather than letting the window server deliver it, keeps Voice inactive and the target focused.
function replayBarPointer(event: BarPointerEvent) {
  if (!panel || panel.isDestroyed()) return;
  const contents = panel.webContents;
  const bounds = panel.getBounds();
  const [x, y, phase] = [event.x - bounds.x, event.y - bounds.y, event.phase];
  if (phase === "down") contents.sendInputEvent({ type: "mouseMove", x, y });
  contents.sendInputEvent({
    type: phase === "down" ? "mouseDown" : "mouseUp",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}
const compactSize = { width: 112, height: 40 };
const expandedSize = { width: 480, height: 84 };
function trayImage(recording: boolean) {
  const image = nativeImage
    .createFromNamedImage(
      recording ? "NSTouchBarRecordStartTemplate" : "NSTouchBarAudioInputTemplate",
    )
    .resize({ height: 18 });
  image.setTemplateImage(true);
  return image;
}
function buildMenu(entries: MenuEntry[]) {
  return Menu.buildFromTemplate(
    entries.map((entry) =>
      "type" in entry
        ? entry
        : {
            label: entry.label,
            enabled: entry.enabled,
            ...(entry.sublabel ? { sublabel: entry.sublabel } : {}),
            ...(entry.run ? { click: entry.run } : {}),
          },
    ),
  );
}
// Menu-bar commands act on the same session as every other entry point.
function syncTray() {
  if (closing || !app.isReady()) return;
  if (!tray || tray.isDestroyed()) tray = new Tray(trayImage(false));
  const snapshot = dictation.snapshot();
  const recording = snapshot.phase === "recording";
  if (recording !== trayRecording) {
    trayRecording = recording;
    tray.setImage(trayImage(recording));
    tray.setToolTip(recording ? "Voice · Recording" : "Voice");
  }
  const entries = menuEntries(snapshot, {
    session: (command) => void dictation.execute(command),
    open: (view) => void openView(view),
    quit: () => app.quit(),
  });
  // Rebuild only when what the menu shows, or the transcript its Copy and Paste target, changed.
  const shown = JSON.stringify([entries, snapshot.lastTranscript]);
  if (shown === trayShown) return;
  trayShown = shown;
  trayMenu = buildMenu(entries);
  tray.setContextMenu(trayMenu);
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
    const firstHelper = superviseHelper();
    const ready = storage.start();
    storageReady = ready;
    void ready.then(
      (settings) => {
        commands.updateSettings(settings);
        notify();
      },
      () => notify(),
    );
    if (closing) return;
    await createWindow();
    await createPanel();
    syncTray();
    screen.on("display-added", () => syncPanel(true));
    screen.on("display-removed", () => syncPanel(true));
    screen.on("display-metrics-changed", () => syncPanel(true));
    void Promise.all([firstHelper, ready]).then(
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

// Main supervises the helper. When it dies, its capture died with it: the session keeps the
// recovery source and a replacement starts after a delay that grows until a helper stays up for
// a minute. A replacement only restores availability and the event-tap state, from the saved
// preferences; it never starts capture or replays a shortcut.
let helperFailures = 0;
let helperReadyAt = 0;
let helperRestart: ReturnType<typeof setTimeout> | undefined;
function superviseHelper() {
  const current = launchHelper(
    app.isPackaged
      ? join(process.resourcesPath, "app.asar.unpacked/native/voice-helper")
      : join(__dirname, "../native/voice-helper"),
    () => failed(),
    {
      testKeychainService: testDirectory
        ? `com.codlume.voice.test.${createHash("sha256").update(app.getPath("userData")).digest("hex")}`
        : undefined,
      syntheticCapture: !!fixtureUrl,
      captureEvent: (event) => {
        dictation.captureEvent(event);
        // A lost device or revoked permission changes availability; show it without waiting.
        if (event.type === "capture.failed") void setup.refresh().then(notify, notify);
      },
      shortcut: (event) => dictation.shortcut(event.action),
      barPointer: (event) => replayBarPointer(event),
      targetSelected: (event) => dictation.targetSelected(event),
    },
  );
  helper = current;
  helperState = "starting";
  let down = false;
  function failed() {
    if (down || helper !== current) return;
    down = true;
    helperState = "failed";
    shortcutState = "unavailable";
    setup.unavailable();
    dictation.helperFailed();
    notify();
    if (closing) return;
    if (helperReadyAt && performance.now() - helperReadyAt > 60_000) helperFailures = 0;
    helperReadyAt = 0;
    const delay = Math.min(30_000, 500 * 2 ** helperFailures++);
    helperRestart = setTimeout(() => {
      helperRestart = undefined;
      if (closing) return;
      void superviseHelper().then(
        async () => {
          await storageReady?.catch(() => {});
          await setup.refresh().catch(() => {});
          await syncShortcuts();
          notify();
        },
        () => {},
      );
    }, delay);
  }
  return current.ready.then(
    () => {
      if (helper !== current || down) throw new Error("native-unavailable");
      helperReadyAt = performance.now();
      helperState = "ready";
      notify();
    },
    (error: unknown) => {
      failed();
      throw error;
    },
  );
}
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
// Opening a section is an explicit action; it may move focus to Voice, which disqualifies
// automatic insertion for a running dictation session and keeps its transcript in recovery.
async function openView(view: View) {
  if (closing) return;
  await showWindow();
  // Menu-bar and floating-bar clicks leave another app active; this explicit request brings Voice.
  app.focus({ steal: true });
  const current = window;
  if (current && !current.isDestroyed()) current.webContents.send(revealChannel, view);
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
  clearTimeout(panelTimer);
  clearTimeout(helperRestart);
  dictation.close();
  if (panel && !panel.isDestroyed()) panel.destroy();
  tray?.destroy();
  void Promise.allSettled([storage?.close(), helper?.close(), provider.close()]).then(() =>
    app.quit(),
  );
});
process.on("SIGTERM", () => app.quit());
process.on("SIGINT", () => app.quit());

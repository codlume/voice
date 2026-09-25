import * as NodePath from "node:path";

import { app, BrowserWindow, clipboard, ipcMain, Menu, screen, shell, Tray } from "electron";

import {
  Channel,
  type PermissionKind,
  type Settings,
  type SettingsPatch,
  type Snapshot,
} from "../shared/api.ts";
import { createCleanup } from "./cleanup.ts";
import { createDictation, type Dictation } from "./dictation.ts";
import { startHelper, type Helper } from "./helper.ts";
import { idle } from "./session.ts";
import { applyPatch, loadSettings, saveSettings } from "./settings.ts";
import { createStore, toSnapshot, type AppState } from "./store.ts";
import { createTrayIcon } from "./tray-icon.ts";

const PILL_WIDTH = 320;
const PILL_HEIGHT = 48;
const PILL_BOTTOM_MARGIN = 12;
const PERMISSION_POLL_MS = 2000;

const PERMISSION_PANES: Record<PermissionKind, string> = {
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

const log = (message: string) => console.log(`[voice] ${message}`);

// Development must never touch the packaged app's storage. This has to run before the single
// instance lock and before ready, because both live under userData.
if (!app.isPackaged) {
  app.setPath("userData", NodePath.join(app.getPath("appData"), "Voice Development"));
}
// The e2e harness runs against a throwaway userData. Only the helper's test flag unlocks
// the override, so the variable alone can never redirect a normal launch.
if (process.env.VOICE_HELPER_TEST === "1" && process.env.VOICE_USER_DATA_DIR) {
  app.setPath("userData", process.env.VOICE_USER_DATA_DIR);
}

if (app.requestSingleInstanceLock()) {
  void main();
} else {
  app.exit(0);
}

function helperBinary(): string {
  if (process.env.VOICE_HELPER_PATH) return process.env.VOICE_HELPER_PATH;
  if (app.isPackaged) return NodePath.join(process.resourcesPath, "bin", "voice-helper");
  return NodePath.join(app.getAppPath(), "../../native/voice-helper/.build/debug/voice-helper");
}

const preload = NodePath.join(__dirname, "preload.cjs");

function loadPage(window: BrowserWindow, page: "hub" | "pill") {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void window.loadURL(new URL(`${page}.html`, devServerUrl).toString());
  } else {
    void window.loadFile(NodePath.join(__dirname, "../dist/renderer", `${page}.html`));
  }
}

function createPillWindow() {
  const pill = new BrowserWindow({
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    type: "panel",
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: { preload },
  });
  pill.setAlwaysOnTop(true, "screen-saver");
  pill.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pill.setIgnoreMouseEvents(true);
  pill.once("ready-to-show", () => pill.showInactive());
  loadPage(pill, "pill");
  return pill;
}

function positionPill(pill: BrowserWindow) {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  pill.setBounds({
    x: Math.round(workArea.x + (workArea.width - PILL_WIDTH) / 2),
    y: workArea.y + workArea.height - PILL_HEIGHT - PILL_BOTTOM_MARGIN,
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
  });
}

function publish(snapshot: Snapshot) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(Channel.snapshot, snapshot);
  }
}

const allGranted = (state: AppState) =>
  Object.values(state.permissions).every((permission) => permission === "granted");

async function main() {
  const userData = app.getPath("userData");
  const modelsDir = NodePath.join(userData, "models");
  const settingsFile = NodePath.join(userData, "settings.json");
  log(`userData ${userData}`);

  const [settings] = await Promise.all([loadSettings(settingsFile), app.whenReady()]);

  const store = createStore({
    session: idle,
    permissions: { microphone: "notDetermined", accessibility: "notDetermined" },
    models: { asr: { state: "missing" }, cleanup: { state: "missing" } },
    settings,
    last: null,
  });

  const cleanup = createCleanup({
    modelsDir,
    onStatus: (status) => store.update((s) => ({ ...s, models: { ...s.models, cleanup: status } })),
  });

  let hub: BrowserWindow | undefined;
  const pill = createPillWindow();
  positionPill(pill);

  // The helper and the dictation runtime reference each other; the helper is created first
  // and dictation reaches it through `send`, which only runs after both exist.
  let dictation: Dictation;
  const helper: Helper = startHelper({
    binary: helperBinary(),
    modelsDir,
    onEvent: (event) => dictation.onHelperEvent(event),
    onExit: () => dictation.dispatch({ type: "helperExited" }),
    configure: () => [
      { type: "hotkey.configure", key: store.state.settings.hotkey },
      { type: "permissions.check" },
      { type: "asr.prepare", download: false },
    ],
    log,
  });
  dictation = createDictation({
    store,
    send: helper.send,
    cleanup,
    onLevel: (level) => {
      if (!pill.isDestroyed()) pill.webContents.send(Channel.level, level);
    },
    log,
  });

  const hubVisible = () => hub !== undefined && !hub.isDestroyed() && hub.isVisible();

  // The hub shows a setup checklist, so while it is open and something is not granted the
  // helper re-checks every 2 s. Otherwise nothing polls.
  let permissionPoll: NodeJS.Timeout | null = null;
  function syncPermissionPolling() {
    const wanted = hubVisible() && !allGranted(store.state);
    if (wanted && !permissionPoll) {
      permissionPoll = setInterval(
        () => helper.send({ type: "permissions.check" }),
        PERMISSION_POLL_MS,
      );
    } else if (!wanted && permissionPoll) {
      clearInterval(permissionPoll);
      permissionPoll = null;
    }
  }

  function showHub() {
    if (hub && !hub.isDestroyed()) {
      hub.show();
      hub.focus();
      return;
    }
    hub = new BrowserWindow({
      width: 960,
      height: 640,
      minWidth: 720,
      minHeight: 480,
      title: "Voice",
      webPreferences: { preload },
    });
    hub.on("focus", () => helper.send({ type: "permissions.check" }));
    hub.on("show", syncPermissionPolling);
    hub.on("hide", syncPermissionPolling);
    hub.on("focus", syncPermissionPolling);
    hub.on("blur", syncPermissionPolling);
    hub.on("closed", syncPermissionPolling);
    loadPage(hub, "hub");
  }

  const tray = new Tray(createTrayIcon());
  tray.setToolTip("Voice");
  function copyLast(which: "text" | "raw") {
    const last = store.state.last;
    if (last) clipboard.writeText(last[which]);
  }
  function refreshTray(state: AppState) {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Voice", click: showHub },
        {
          label: "Copy last transcript",
          enabled: state.last !== null,
          click: () => copyLast("text"),
        },
        { type: "separator" },
        { label: "Quit", role: "quit" },
      ]),
    );
  }
  refreshTray(store.state);

  store.subscribe((state, previous) => {
    publish(toSnapshot(state));
    if (state.session.phase === "starting" && previous.session.phase !== "starting") {
      positionPill(pill);
    }
    if (state.last !== previous.last) refreshTray(state);
    if (state.permissions !== previous.permissions) syncPermissionPolling();
  });

  // Saves are serialized so two quick edits cannot race on the temp file or land out of order.
  let saving: Promise<void> = Promise.resolve();
  function updateSettings(patch: SettingsPatch) {
    const previous: Settings = store.state.settings;
    const next = applyPatch(previous, patch);
    store.update((s) => ({ ...s, settings: next }));
    if (next.hotkey !== previous.hotkey)
      helper.send({ type: "hotkey.configure", key: next.hotkey });
    saving = saving.catch(() => {}).then(() => saveSettings(settingsFile, next));
    return saving;
  }

  function requestPermission(kind: PermissionKind) {
    if (store.state.permissions[kind] === "denied") {
      // The system prompt never reappears once denied; the user has to flip it in Settings.
      void shell.openExternal(PERMISSION_PANES[kind]);
      return;
    }
    helper.send({ type: "permissions.request", kind });
  }

  function setupModels() {
    helper.send({ type: "asr.prepare", download: true });
    void cleanup.setup();
  }

  ipcMain.handle(Channel.getSnapshot, () => toSnapshot(store.state));
  ipcMain.handle(Channel.updateSettings, (_event, patch: SettingsPatch) => updateSettings(patch));
  ipcMain.handle(Channel.requestPermission, (_event, kind: PermissionKind) => {
    if (kind in PERMISSION_PANES) requestPermission(kind);
  });
  ipcMain.handle(Channel.setupModels, () => setupModels());
  ipcMain.handle(Channel.copyLast, (_event, which: "text" | "raw") => {
    copyLast(which === "raw" ? "raw" : "text");
  });

  app.on("second-instance", showHub);
  app.on("activate", showHub);
  // The tray keeps the app alive after the hub window closes.
  app.on("window-all-closed", () => {});
  app.on("before-quit", () => {
    void helper.stop();
    void cleanup.dispose();
  });

  showHub();
  void cleanup.load();
}

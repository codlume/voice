import { readFileSync } from "node:fs";
import * as NodePath from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  shell,
  Tray,
  type WebPreferences,
} from "electron";
import { autoUpdater } from "electron-updater";

import {
  Channel,
  DIAGNOSTICS_ARGUMENT,
  sameTranscript,
  type LoginItem,
  type PermissionKind,
  type SettingsPatch,
  type Snapshot,
} from "../shared/api.ts";
import { wantsCleanup } from "../shared/dictation-language.ts";
import { models, type Model, type ModelId } from "../shared/models.ts";
import { createCleanup } from "./cleanup.ts";
import type { Log } from "./diagnostics-scrub.ts";
import { startDiagnostics } from "./diagnostics.ts";
import { createDockSync } from "./dock.ts";
import type * as SentryEntry from "./sentry.ts";
import { createDictation, type Dictation } from "./dictation.ts";
import { startHelper, type Helper } from "./helper.ts";
import { createMicrophoneTest, type MicrophoneTest } from "./microphone-test.ts";
import { idle } from "./session.ts";
import { applyPatch, loadSettings, saveSettings } from "./settings.ts";
import { createStore, toSnapshot, type AppState } from "./store.ts";
import { createTrayIcon } from "./tray-icon.ts";
import { createUpdates, parseReleaseConfig, parseRestartRequest } from "./updates.ts";

const PILL_WIDTH = 320;
const PILL_HEIGHT = 48;
const PILL_BOTTOM_MARGIN = 12;
const PERMISSION_POLL_MS = 2000;
const SHUTDOWN_TIMEOUT_MS = 3000;
const DIAGNOSTICS_FLUSH_MS = 1000;

const LOGIN_ITEMS_PANE = "x-apple.systempreferences:com.apple.LoginItems-Settings.extension";
const PERMISSION_PANES: Record<PermissionKind, string> = {
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

// The VOICE_* switches (test mode, a scratch userData, a helper build) are for development runs
// only. A packaged app ignores them and never hands them to its helper.
const development = !app.isPackaged;
const testMode = development && process.env.VOICE_HELPER_TEST === "1";

// Development must never touch the packaged app's storage. This has to run before the single
// instance lock and before ready, because both live under userData.
if (development) {
  app.setPath("userData", NodePath.join(app.getPath("appData"), "Voice Development"));
  if (testMode && process.env.VOICE_USER_DATA_DIR) {
    app.setPath("userData", process.env.VOICE_USER_DATA_DIR);
  }
}

function helperBinary(): string {
  if (!development) return NodePath.join(process.resourcesPath, "bin", "voice-helper");
  return (
    process.env.VOICE_HELPER_PATH ??
    NodePath.join(app.getAppPath(), "../../native/voice-helper/.build/debug/voice-helper")
  );
}

function helperEnv(): NodeJS.ProcessEnv {
  if (development) return process.env;
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("VOICE_")),
  );
}

// A development build would register the bare Electron binary to open at login.
function readLoginItem(): LoginItem {
  if (development) return "unavailable";
  const { status } = app.getLoginItemSettings();
  if (status === "enabled") return "on";
  if (status === "requires-approval") return "needsApproval";
  return "off";
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

function createPillWindow(webPreferences: WebPreferences) {
  const pill = new BrowserWindow({
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    // A panel already joins every Space and floats over fullscreen apps. Calling
    // setVisibleOnAllWorkspaces for that would also drop Voice from the Dock and Cmd-Tab.
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
    webPreferences,
  });
  pill.setAlwaysOnTop(true, "screen-saver");
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
  // Printed before diagnostics start, and a path to the user's home never leaves the machine.
  console.log(`[voice] userData ${userData}`);

  const manifest: unknown = JSON.parse(
    readFileSync(NodePath.join(app.getAppPath(), "package.json"), "utf8"),
  );
  const release =
    !development && typeof manifest === "object" && manifest !== null && "voiceRelease" in manifest
      ? parseReleaseConfig(manifest.voiceRelease)
      : null;
  const installedChannel = release?.channel ?? "stable";
  const settings = loadSettings(settingsFile, installedChannel);
  let lifecycle: "running" | "stopping" | "stopped" | "failed" = "running";
  let saving: Promise<void> = Promise.resolve();

  const store = createStore({
    session: idle,
    permissions: { microphone: "notDetermined", accessibility: "notDetermined" },
    loginItem: "unavailable",
    models: { asr: { state: "missing" }, cleanup: { state: "missing" } },
    settings,
    updates: {
      version: app.getVersion(),
      installedChannel,
      channel: settings.updateChannel,
      status:
        release && process.platform === "darwin" && process.arch === "arm64"
          ? { kind: "idle" }
          : {
              kind: "disabled",
              reason: development
                ? "Updates are disabled in development builds."
                : "Updates are unavailable in this build.",
            },
    },
    microphones: { kind: "loading" },
    microphoneTest: { kind: "off" },
    last: null,
  });

  // The SDK has to start before ready, so the consent read at launch decides whether it runs.
  const diagnostics = startDiagnostics({
    loadSdk: (): typeof SentryEntry => require(NodePath.join(__dirname, "sentry.cjs")),
    dsn: process.env.VOICE_SENTRY_DSN ?? "",
    release: `voice@${app.getVersion()}`,
    environment: development ? "development" : installedChannel,
    tracesSampleRate: development ? 1 : 0.2,
    consent: () => store.state.settings.diagnostics,
    crashDumpsDir: app.getPath("crashDumps"),
  });
  const log: Log = (message, entry) => {
    console.log(`[voice] ${message}`);
    if (entry) diagnostics.log(entry);
  };
  const webPreferences: WebPreferences = {
    preload,
    additionalArguments: diagnostics.active ? [DIAGNOSTICS_ARGUMENT] : [],
  };

  // The user can change Login Items in System Settings, so macOS owns this state.
  function refreshLoginItem() {
    const loginItem = readLoginItem();
    store.update((s) => (s.loginItem === loginItem ? s : { ...s, loginItem }));
  }

  await app.whenReady();
  nativeTheme.themeSource = settings.theme;
  refreshLoginItem();
  if (!settings.showInDock) app.dock?.hide();

  const cleanup = createCleanup({
    modelsDir,
    shouldLoad: () => wantsCleanup(store.state.settings),
    onStatus: (status) => store.update((s) => ({ ...s, models: { ...s.models, cleanup: status } })),
  });

  let hub: BrowserWindow | undefined;
  const pill = createPillWindow(webPreferences);
  positionPill(pill);

  let dictation: Dictation;
  let microphoneTest: MicrophoneTest;
  const helper: Helper = startHelper({
    binary: helperBinary(),
    modelsDir,
    env: helperEnv(),
    onEvent: (event) => {
      if (lifecycle !== "running") return;
      dictation.onHelperEvent(event);
      microphoneTest.onHelperEvent(event);
    },
    onExit: (exit) => {
      if (lifecycle === "running") {
        diagnostics.helperExited(exit);
        store.update((s) => ({
          ...s,
          microphones: {
            kind: "unavailable",
            message: "Microphones are unavailable while Voice reconnects.",
          },
        }));
        dictation.dispatch({ type: "helperExited" });
        microphoneTest.helperExited();
      }
    },
    configure: () => [
      { type: "hotkey.configure", key: store.state.settings.hotkey },
      { type: "microphone.configure", microphone: store.state.settings.microphone },
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
    onSessionDone: diagnostics.sessionDone,
  });
  // The pill keeps dictation levels; the hub's onLevel carries only test levels.
  microphoneTest = createMicrophoneTest({
    store,
    send: helper.send,
    onLevel: (level) => {
      if (hub && !hub.isDestroyed()) hub.webContents.send(Channel.level, level);
    },
  });

  const dictating = () =>
    store.state.session.phase !== "idle" && store.state.session.phase !== "done";

  const updates = createUpdates({
    engine: store.state.updates.status.kind === "disabled" ? null : autoUpdater,
    release,
    initial: store.state.updates,
    onChange: (value) => store.update((s) => ({ ...s, updates: value })),
    canRestart: () =>
      lifecycle === "running" &&
      !dictating() &&
      store.state.settings.updateChannel === store.state.updates.channel,
    prepareRestart: async () => {
      lifecycle = "stopping";
      try {
        await saving;
      } catch (error) {
        lifecycle = "running";
        throw error;
      }
      stopPermissionPolling();
      try {
        await shutdown(true);
      } catch (error) {
        lifecycle = "failed";
        throw error;
      }
      lifecycle = "stopped";
    },
    onRestartFailure: () => {
      if (lifecycle === "running") return;
      dialog.showErrorBox(
        "Voice update",
        "The update could not be installed. Voice will reopen its current version so you can keep dictating and try again.",
      );
      app.relaunch();
      app.quit();
    },
  });

  const hubVisible = () => hub !== undefined && !hub.isDestroyed() && hub.isVisible();

  let permissionPoll: NodeJS.Timeout | null = null;
  function stopPermissionPolling() {
    if (permissionPoll) clearInterval(permissionPoll);
    permissionPoll = null;
  }
  function syncPermissionPolling() {
    const wanted = lifecycle === "running" && hubVisible() && !allGranted(store.state);
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

  function showHub(): BrowserWindow {
    if (hub && !hub.isDestroyed()) {
      hub.show();
      hub.focus();
      return hub;
    }
    hub = new BrowserWindow({
      width: 960,
      height: 640,
      minWidth: 720,
      minHeight: 480,
      title: "Voice",
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 16, y: 18 },
      // StyleX tokens cannot be imported here, so this repeats color.sidebar as hex
      // (BrowserWindow rejects oklch). It keeps a dark first frame from flashing white.
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#111111" : "#fafafa",
      webPreferences,
    });
    hub.on("focus", () => {
      helper.send({ type: "permissions.check" });
      refreshLoginItem();
    });
    hub.on("show", syncPermissionPolling);
    hub.on("hide", syncPermissionPolling);
    hub.on("focus", syncPermissionPolling);
    hub.on("blur", syncPermissionPolling);
    hub.on("closed", syncPermissionPolling);
    hub.on("hide", microphoneTest.stop);
    hub.on("minimize", microphoneTest.stop);
    hub.on("closed", microphoneTest.stop);
    loadPage(hub, "hub");
    return hub;
  }

  // A request sent while the hub is still loading would reach the old document and be lost.
  function requestRestart() {
    const contents = showHub().webContents;
    const send = () => {
      if (!contents.isDestroyed()) contents.send(Channel.requestRestart);
    };
    if (contents.isLoading()) contents.once("did-finish-load", send);
    else send();
  }

  const syncDock = createDockSync({
    dock: app.dock,
    showInDock: () => store.state.settings.showInDock,
    wait: delay,
    afterChange: () => {
      if (hubVisible()) {
        showHub();
        app.focus({ steal: true });
      }
    },
    log,
  });

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
        {
          label:
            state.updates.status.kind === "ready" ? "Restart to update…" : "Check for updates…",
          enabled:
            state.updates.status.kind !== "disabled" && state.updates.status.kind !== "installing",
          click: () => {
            if (state.updates.status.kind === "ready") {
              requestRestart();
            } else {
              showHub();
              void updates.check();
            }
          },
        },
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
    if (state.last !== previous.last || state.updates !== previous.updates) refreshTray(state);
    if (state.permissions !== previous.permissions) syncPermissionPolling();
    if (!state.settings.cleanup.enabled && previous.settings.cleanup.enabled) {
      void cleanup.unload();
    } else if (wantsCleanup(state.settings) && !wantsCleanup(previous.settings)) {
      void cleanup.loadIfDownloaded();
    }
  });

  async function updateSettings(patch: SettingsPatch) {
    if (lifecycle !== "running" || store.state.updates.status.kind === "installing")
      throw new Error("Voice is restarting.");
    const previous = store.state.settings;
    const next = applyPatch(previous, patch);
    store.update((s) => ({ ...s, settings: next }));
    if (next.hotkey !== previous.hotkey)
      helper.send({ type: "hotkey.configure", key: next.hotkey });
    if (next.microphone?.uid !== previous.microphone?.uid)
      helper.send({ type: "microphone.configure", microphone: next.microphone });
    if (next.theme !== previous.theme) nativeTheme.themeSource = next.theme;
    if (next.showInDock !== previous.showInDock) void syncDock();
    saving = saving.catch(() => {}).then(() => saveSettings(settingsFile, next));
    await saving;
    if (next.updateChannel === store.state.settings.updateChannel)
      await updates.setChannel(next.updateChannel);
  }

  function requestPermission(kind: PermissionKind) {
    if (store.state.permissions[kind] === "denied") {
      // The system prompt never reappears once denied; the user has to flip it in Settings.
      void shell.openExternal(PERMISSION_PANES[kind]);
      return;
    }
    helper.send({ type: "permissions.request", kind });
  }

  const modelControls: Record<ModelId, { install(): void; uninstall(): Promise<void> }> = {
    asr: {
      install: () => helper.send({ type: "asr.prepare", download: true }),
      uninstall: async () => helper.send({ type: "asr.remove" }),
    },
    cleanup: {
      install: () => void cleanup.install(),
      uninstall: () => cleanup.uninstall(),
    },
  };

  function assertCanUninstall(model: Model) {
    if (lifecycle !== "running") throw new Error("Voice is closing.");
    const { state } = store.state.models[model.id];
    if (state === "downloading" || state === "loading") {
      throw new Error(`Wait for the ${model.kind.toLowerCase()} to finish ${state}.`);
    }
    if (model.neededWhileDictating && dictating()) {
      throw new Error(`Finish dictating, then uninstall the ${model.kind.toLowerCase()}.`);
    }
  }

  ipcMain.handle(Channel.getSnapshot, () => toSnapshot(store.state));
  ipcMain.handle(Channel.checkForUpdates, () => updates.check());
  ipcMain.handle(Channel.restartForUpdate, (_event, value: unknown) => {
    const request = parseRestartRequest(value);
    if (!request) return;
    const last = store.state.last;
    if (!sameTranscript(request.last, last)) {
      throw new Error("A new transcript arrived. Check it, then restart.");
    }
    return updates.restart(
      request.choice === "copyTranscriptAndRestart" && last
        ? () => clipboard.writeText(last.text || last.raw)
        : undefined,
    );
  });
  ipcMain.handle(Channel.openRelease, () => {
    const url = updates.releaseUrl();
    if (url) void shell.openExternal(url);
  });
  ipcMain.handle(Channel.updateSettings, (_event, patch: SettingsPatch) => updateSettings(patch));
  ipcMain.handle(Channel.requestPermission, (_event, kind: PermissionKind) => {
    if (Object.hasOwn(PERMISSION_PANES, kind)) requestPermission(kind);
  });
  ipcMain.handle(Channel.setOpenAtLogin, (_event, on: boolean) => {
    if (development) return;
    const openAtLogin = on === true;
    // Registering again does not approve the item. Only the user can, in Login Items.
    if (openAtLogin && store.state.loginItem === "needsApproval") {
      void shell.openExternal(LOGIN_ITEMS_PANE);
      return;
    }
    app.setLoginItemSettings({ openAtLogin });
    refreshLoginItem();
  });
  ipcMain.handle(Channel.startMicrophoneTest, () => {
    if (lifecycle === "running") microphoneTest.start();
  });
  ipcMain.handle(Channel.stopMicrophoneTest, () => microphoneTest.stop());
  ipcMain.handle(Channel.installModel, (_event, id: unknown) => {
    const model = models.find((candidate) => candidate.id === id);
    if (model && lifecycle === "running") modelControls[model.id].install();
  });
  ipcMain.handle(Channel.uninstallModel, (_event, id: unknown) => {
    const model = models.find((candidate) => candidate.id === id);
    if (!model) return;
    assertCanUninstall(model);
    return modelControls[model.id].uninstall();
  });
  ipcMain.handle(Channel.copyLast, (_event, which: "text" | "raw") => {
    copyLast(which === "raw" ? "raw" : "text");
  });

  app.on("second-instance", showHub);
  app.on("activate", showHub);
  // The tray keeps the app alive after the hub window closes.
  app.on("window-all-closed", () => {});

  // node-llama-cpp frees the model on a native worker. If Electron tears Node down while that
  // worker is in flight, its completion callback throws into a dying environment and the
  // process aborts. So the first quit only starts the shutdown; the quit that follows it passes.
  async function shutdown(forUpdate = false) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS, "timeout");
    });
    const stopped = Promise.allSettled([saving, helper.stop(), cleanup.dispose()]);
    const result = await Promise.race([stopped, timeout]);
    clearTimeout(timer);
    if (result === "timeout") {
      log(`quit: shutdown still running after ${SHUTDOWN_TIMEOUT_MS} ms`, {
        message: "shutdown overran",
        level: "warn",
        attributes: { "shutdown.timeout_ms": SHUTDOWN_TIMEOUT_MS },
      });
    }
    // Logs wait in a buffer, and Electron main never emits beforeExit to send them.
    await diagnostics.flush(DIAGNOSTICS_FLUSH_MS);
    if (!forUpdate) return;
    if (result === "timeout") {
      throw new Error("Voice is still stopping. Quit and reopen Voice before updating.");
    }
    if (result.some((item) => item.status === "rejected")) {
      throw new Error("Voice could not stop safely. Quit and reopen Voice before updating.");
    }
  }
  app.on("before-quit", (event) => {
    if (lifecycle === "stopped") return;
    event.preventDefault();
    if (lifecycle === "stopping") return;
    lifecycle = "stopping";
    updates.dispose();
    stopPermissionPolling();
    void shutdown().then(() => {
      lifecycle = "stopped";
      app.quit();
    });
  });

  showHub();
  updates.start();
  void cleanup.loadIfDownloaded();
  // Lets scripts/quit-smoke.mjs start a cleanup through the inspector and quit during it.
  if (testMode) Object.assign(globalThis, { voiceTest: { cleanup } });
}

// Called last because main runs synchronously until whenReady and reads module constants.
if (app.requestSingleInstanceLock()) {
  void main();
} else {
  app.exit(0);
}

import { readFileSync } from "node:fs";
import * as NodePath from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  Menu,
  nativeTheme,
  powerMonitor,
  screen,
  session,
  shell,
  Tray,
  type WebPreferences,
} from "electron";
import * as Option from "effect/Option";
import type * as ElectronUpdater from "electron-updater";

import {
  Channel,
  DIAGNOSTICS_ARGUMENT,
  toPillSnapshot,
  type LoginItem,
  type PermissionKind,
  type PillApi,
  type RestartRequest,
  type Settings,
  VOICE_URL_SCHEME,
} from "../shared/api.ts";
import { wantsCleanup } from "../shared/dictation-language.ts";
import { copyText } from "../shared/history.ts";
import type { BusyDuring, Model, ModelId } from "../shared/models.ts";
import { trafficLightPosition } from "../shared/titlebar.ts";
import { runsAfterDictation } from "../shared/transforms.ts";
import { nextZoomLevel, zoomFactor } from "../shared/zoom.ts";
import { authSessionStored, authStored } from "./account-storage.ts";
import {
  SIGN_IN_TIMEOUT_MS,
  callbackUrlFromArgv,
  createAccount,
  resolveApiUrl,
} from "./account.ts";
import { activity, whenIdle } from "./activity.ts";
import { createCleanup, followSettings } from "./cleanup.ts";
import type { Log } from "./diagnostics-scrub.ts";
import { startDiagnostics } from "./diagnostics.ts";
import { createDockSync } from "./dock.ts";
import type * as SentryEntry from "./sentry.ts";
import { createDictation, type Dictation } from "./dictation.ts";
import { findHelperCrash } from "./helper-crash.ts";
import { startHelper, type Helper } from "./helper.ts";
import { hotkeyConfigure } from "./hotkey-config.ts";
import { registerHubCommands, type HubCommandDeps } from "./hub-commands.ts";
import { hubMinimumSize, hubWindowSize } from "./hub-window.ts";
import { createHistory } from "./history.ts";
import { createInsights } from "./insights.ts";
import { createInstalledApps, type InstalledApps } from "./installed-apps.ts";
import type { Commands } from "./ipc.ts";
import { denyPermissions, lockNavigation, pageUrl, type Page } from "./lockdown.ts";
import { createApplicationMenu } from "./menu.ts";
import { createMicrophoneTest, type MicrophoneTest } from "./microphone-test.ts";
import { decodeTarget } from "./protocol.ts";
import { publish } from "./publish.ts";
import { idle } from "./session.ts";
import { createSettingsQueue, type SettingsQueue } from "./settings-queue.ts";
import { applyPatch, openSettings } from "./settings.ts";
import { createStore, toSnapshot, type AppState } from "./store.ts";
import { createTrayIcon } from "./tray-icon.ts";
import { createTransformModel } from "./transform-model.ts";
import { createTransforms, followTransformSettings, type Transforms } from "./transforms.ts";
import { idleRun } from "./transform-run.ts";
import { createUpdates, parseReleaseConfig, restartRefusal } from "./updates.ts";

const PILL_WIDTH = 320;
const PILL_HEIGHT = 48;
const PILL_BOTTOM_MARGIN = 12;
const PERMISSION_POLL_MS = 2000;
const SHUTDOWN_TIMEOUT_MS = 3000;
const DIAGNOSTICS_FLUSH_MS = 1000;

const FINISH_FIRST: Record<BusyDuring, string> = {
  dictation: "Finish dictating",
  transform: "Finish the transform",
};
const PERMISSION_PANES: Record<PermissionKind, string> = {
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

// The VOICE_* switches (test mode, a scratch userData, a helper build) are for development runs
// only. A packaged app ignores them and never hands them to its helper.
const development = !app.isPackaged;
const testMode = development && process.env.VOICE_HELPER_TEST === "1";

// safeStorage names its Keychain item after the app, so the rename keeps development off "Voice
// Safe Storage". All of this has to run before ready, because Electron reads the name when its main
// loop starts and the single instance lock lives under userData.
if (development) {
  app.setName("Voice Dev");
  app.setPath("userData", NodePath.join(app.getPath("appData"), "Voice Development"));
  if (testMode && process.env.VOICE_USER_DATA_DIR) {
    app.setPath("userData", process.env.VOICE_USER_DATA_DIR);
    // The stock Electron that verify and e2e launch would get a Keychain prompt for the Voice Dev
    // item, and an agent cannot answer it. A scratch userData needs only scratch secrets.
    app.commandLine.appendSwitch("use-mock-keychain");
  }
}

// The verify skill plays the browser through this file, and can shorten the sign-in timeout.
const signInUrlFile = testMode ? NodePath.join(app.getPath("userData"), "sign-in-url.txt") : null;
const testTimeoutMs = testMode ? Number(process.env.VOICE_SIGN_IN_TIMEOUT_MS) : Number.NaN;
const signInTimeoutMs =
  Number.isSafeInteger(testTimeoutMs) && testTimeoutMs > 0 ? testTimeoutMs : SIGN_IN_TIMEOUT_MS;

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

// macOS delivers a launch by URL only to a listener that exists before ready. main() points this
// at the account module synchronously, before any event can arrive, and once the hub exists, at
// a handler that also brings the hub forward.
let handleCallbackUrl: (url: string) => void = () => {};
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleCallbackUrl(url);
});

// Test runs launch the stock Electron.app, which does not declare the scheme. Making it the
// default handler would take the sign-in link away from a Voice that can receive it. Only
// pnpm dev on macOS runs a bundle that declares it; elsewhere the read fails and Voice skips.
function receivesCallbackUrls(): boolean {
  if (!development) return true;
  try {
    const info = readFileSync(NodePath.join(process.execPath, "../../Info.plist"), "utf8");
    return info.includes(`<string>${VOICE_URL_SCHEME}</string>`);
  } catch {
    return false;
  }
}

const rendererDir = NodePath.join(__dirname, "../dist/renderer");

function loadPage(window: BrowserWindow, page: Page) {
  void window.loadURL(pageUrl(page, { development, env: process.env, rendererDir }));
}

function createPillWindow(webPreferencesFor: (page: Page) => WebPreferences) {
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
    // Chromium shares one zoom level between pages on the same host, as the dev server serves both
    // windows; "isolated" keeps the pill out of it however the pages load.
    webPreferences: { ...webPreferencesFor("pill"), zoomMode: "isolated" },
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

function applyZoom(hub: BrowserWindow, zoomLevel: number) {
  hub.webContents.setZoomLevel(zoomLevel);
  if (process.platform === "darwin") hub.setWindowButtonPosition(trafficLightPosition(zoomLevel));
  const minimum = hubMinimumSize(zoomLevel);
  hub.setMinimumSize(minimum.width, minimum.height);
  const bounds = hub.getBounds();
  if (bounds.width >= minimum.width && bounds.height >= minimum.height) return;
  const { workArea } = screen.getDisplayMatching(bounds);
  const width = Math.min(Math.max(bounds.width, minimum.width), workArea.width);
  const height = Math.min(Math.max(bounds.height, minimum.height), workArea.height);
  hub.setBounds({
    x: Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height)),
    width,
    height,
  });
}

const allGranted = (state: AppState) =>
  Object.values(state.permissions).every((permission) => permission === "granted");

async function main() {
  const userData = app.getPath("userData");
  const modelsDir = NodePath.join(userData, "models");
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
  const testCheckIntervalMs = testMode ? Number(process.env.VOICE_AUTH_SESSION_CHECK_MS) : 0;
  const account = createAccount({
    apiUrl: resolveApiUrl({ development, release, env: process.env }),
    development,
    hasStoredAuthSession: () => authSessionStored(userData, installedChannel),
    hasStoredAuth: () => authStored(userData, installedChannel),
    // The verify skill shortens the hourly check to bring the window back after it.
    ...(testCheckIntervalMs > 0 && { checkIntervalMs: testCheckIntervalMs }),
    createClient: (apiUrl) =>
      import("./account-client.ts").then((m) =>
        m.createVoiceAuthClient({
          apiUrl,
          log,
          installedChannel,
          ...(signInUrlFile && { signInUrlFile }),
        }),
      ),
    signInTimeoutMs,
    onChange: (value) => store.update((s) => ({ ...s, account: value })),
    log: (message, entry) => log(message, entry),
  });
  handleCallbackUrl = account.handleCallbackUrl;
  const settingsFile = openSettings(
    NodePath.join(userData, "settings.json"),
    installedChannel,
    (message, entry) => log(message, entry),
  );
  const { settings } = settingsFile;
  let lifecycle: "running" | "stopping" | "stopped" | "failed" = "running";
  let settingsQueue: SettingsQueue;

  const store = createStore({
    session: idle,
    transform: idleRun,
    permissions: { microphone: "notDetermined", accessibility: "notDetermined" },
    loginItem: "unavailable",
    models: {
      asr: { state: "missing" },
      cleanup: { state: "missing" },
      transform: { state: "missing" },
    },
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
    account: account.state,
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
    findHelperCrash: (pid) =>
      findHelperCrash(pid, {
        dir: NodePath.join(app.getPath("home"), "Library", "Logs", "DiagnosticReports"),
        since: Date.now() - 10_000,
        timeoutMs: 10_000,
        intervalMs: 500,
      }),
  });
  const log: Log = (message, entry) => {
    console.log(`[voice] ${message}`);
    if (entry) diagnostics.log(entry);
  };
  const webPreferencesFor = (page: Page): WebPreferences => ({
    preload: NodePath.join(__dirname, `${page}-preload.cjs`),
    additionalArguments: diagnostics.active ? [DIAGNOSTICS_ARGUMENT] : [],
  });

  // The user can change Login Items in System Settings, so macOS owns this state.
  function refreshLoginItem() {
    const loginItem = readLoginItem();
    store.update((s) => (s.loginItem === loginItem ? s : { ...s, loginItem }));
  }

  app.on("web-contents-created", (_event, contents) => lockNavigation(contents));
  await app.whenReady();
  denyPermissions(session.defaultSession);
  nativeTheme.themeSource = settings.theme;
  refreshLoginItem();
  if (!settings.showInDock) app.dock?.hide();

  const cleanup = createCleanup({
    modelsDir,
    baseUrl: testMode ? process.env.VOICE_CLEANUP_MODEL_URL : undefined,
    shouldLoad: () => wantsCleanup(store.state.settings),
    onStatus: (status) => store.update((s) => ({ ...s, models: { ...s.models, cleanup: status } })),
    log,
  });
  const transformModel = createTransformModel({
    modelsDir,
    baseUrl: testMode ? process.env.VOICE_TRANSFORM_MODEL_URL : undefined,
    keepLoaded: () => runsAfterDictation(store.state.settings.transforms),
    onStatus: (status) =>
      store.update((s) => ({ ...s, models: { ...s.models, transform: status } })),
    log,
  });

  let hub: BrowserWindow | undefined;
  const pill = createPillWindow(webPreferencesFor);
  positionPill(pill);

  let dictation: Dictation;
  let transforms: Transforms;
  let microphoneTest: MicrophoneTest;
  let installedApps: InstalledApps;
  let sentHotkeys: ReturnType<typeof hotkeyConfigure> | null = null;
  const hubFocused = () => hub !== undefined && !hub.isDestroyed() && hub.isFocused();
  const hotkeys = () => hotkeyConfigure(store.state.settings, hubFocused());
  function syncHotkeys() {
    const next = hotkeys();
    if (sentHotkeys && isDeepStrictEqual(next, sentHotkeys)) return;
    sentHotkeys = next;
    helper.send(next);
  }
  const helper: Helper = startHelper({
    binary: helperBinary(),
    modelsDir,
    stateDir: userData,
    env: helperEnv(),
    onEvent: (event) => {
      if (lifecycle !== "running") return;
      dictation.onHelperEvent(event);
      transforms.onHelperEvent(event);
      microphoneTest.onHelperEvent(event);
      installedApps.onHelperEvent(event);
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
        transforms.dispatch({ type: "helperExited" });
        microphoneTest.helperExited();
        installedApps.helperExited();
      }
    },
    configure: () => {
      sentHotkeys = hotkeys();
      return [
        sentHotkeys,
        { type: "microphone.configure", microphone: store.state.settings.microphone },
        { type: "permissions.check" },
        { type: "asr.prepare", download: false },
      ];
    },
    log,
  });
  // The tray reads the newest entry when clicked, so it is rebuilt only when it goes from none to
  // some or back.
  let trayHasEntry = false;
  const history = createHistory({
    file: NodePath.join(userData, "history.json"),
    log,
    onChange: (state) => {
      if (hub && !hub.isDestroyed()) hub.webContents.send(Channel.history, state);
      const hasEntry = state.entries.length > 0;
      if (hasEntry === trayHasEntry) return;
      trayHasEntry = hasEntry;
      refreshTray(store.state);
    },
  });
  // The expiry timer counts awake time only, so a window that ended during sleep ends on wake.
  powerMonitor.on("resume", history.expire);
  const insights = createInsights({
    file: NodePath.join(userData, "insights.json"),
    log,
    onChange: (value) => {
      if (hub && !hub.isDestroyed()) hub.webContents.send(Channel.insights, value);
    },
  });
  dictation = createDictation({
    store,
    send: helper.send,
    cleanup,
    transform: { model: transformModel, remember: (value) => transforms.remember(value) },
    onLevel: (level) => {
      if (!pill.isDestroyed()) pill.webContents.send(Channel.level, level);
    },
    log,
    onSessionDone: diagnostics.sessionDone,
    onDictated: insights.record,
    history,
    // Without the charset, readers decode the HTML as Latin-1, as in the helper's paste.
    copy: ({ text, html }) =>
      html === null
        ? clipboard.writeText(text)
        : clipboard.write([
            new ClipboardItem({ "text/plain": text, "text/html": `<meta charset="utf-8">${html}` }),
          ]),
  });
  transforms = createTransforms({
    store,
    send: helper.send,
    model: transformModel,
    log,
    copy: (text) => clipboard.writeText(text),
    onLastTransform: (value) => {
      if (hub && !hub.isDestroyed()) hub.webContents.send(Channel.lastTransform, value);
    },
  });
  // The pill keeps dictation levels; the hub's onLevel carries only test levels.
  microphoneTest = createMicrophoneTest({
    store,
    send: helper.send,
    onLevel: (level) => {
      if (hub && !hub.isDestroyed()) hub.webContents.send(Channel.level, level);
    },
  });

  installedApps = createInstalledApps({ send: helper.send });

  const runWhenIdle = whenIdle(store);
  const updates = createUpdates({
    whenIdle: runWhenIdle,
    loadEngine:
      store.state.updates.status.kind === "disabled"
        ? null
        : (): typeof ElectronUpdater.autoUpdater => require("electron-updater").autoUpdater,
    release,
    initial: store.state.updates,
    onChange: (value) => store.update((s) => ({ ...s, updates: value })),
    canRestart: () =>
      lifecycle === "running" &&
      activity(store.state) === "idle" &&
      store.state.settings.updateChannel === store.state.updates.channel,
    prepareRestart: async () => {
      lifecycle = "stopping";
      await settingsQueue.settled();
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
    } else if (!wanted) {
      stopPermissionPolling();
    }
  }

  function showHub(): BrowserWindow {
    if (hub && !hub.isDestroyed()) {
      hub.show();
      hub.focus();
      return hub;
    }
    hub = new BrowserWindow({
      ...hubWindowSize(screen.getPrimaryDisplay().workArea, store.state.settings.zoomLevel),
      title: "Voice",
      titleBarStyle: "hidden",
      trafficLightPosition: trafficLightPosition(store.state.settings.zoomLevel),
      // StyleX tokens cannot be imported here, so this repeats color.sidebar as hex
      // (BrowserWindow rejects oklch). It keeps a dark first frame from flashing white.
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#111111" : "#fafafa",
      webPreferences: {
        ...webPreferencesFor("hub"),
        zoomFactor: zoomFactor(store.state.settings.zoomLevel),
      },
    });
    // zoomFactor paints the first frame at the saved size. setZoomLevel only takes once a page has
    // committed, so a zoom pressed before the first load is reapplied here.
    const contents = hub.webContents;
    contents.on("did-finish-load", () => contents.setZoomLevel(store.state.settings.zoomLevel));
    // The window came back (shown, unminimized, Cmd-Tab): re-read what may have changed meanwhile.
    hub.on("focus", () => {
      helper.send({ type: "permissions.check" });
      refreshLoginItem();
      void account.refresh();
      history.expire();
      syncHotkeys();
    });
    hub.on("blur", syncHotkeys);
    hub.on("closed", syncHotkeys);
    hub.on("show", syncPermissionPolling);
    hub.on("hide", syncPermissionPolling);
    hub.on("minimize", syncPermissionPolling);
    hub.on("restore", syncPermissionPolling);
    hub.on("focus", syncPermissionPolling);
    hub.on("blur", syncPermissionPolling);
    hub.on("closed", syncPermissionPolling);
    hub.on("hide", microphoneTest.stop);
    hub.on("minimize", microphoneTest.stop);
    hub.on("closed", microphoneTest.stop);
    // Restore loads Better Auth and reads the Keychain, so it waits until the window has loaded.
    // Not ready-to-show: a window covered by another app paints nothing, and restore would wait.
    hub.webContents.once("did-finish-load", () => void account.restore());
    registerHubCommands(hub.webContents.ipc, hubCommandDeps);
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
  function refreshTray(state: AppState) {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Voice", click: showHub },
        {
          label: "Copy last transcript",
          enabled: trayHasEntry,
          click: () => {
            const [latest] = history.entries();
            if (latest) clipboard.writeText(copyText(latest));
          },
        },
        { type: "separator" },
        {
          label:
            state.updates.status.kind === "available"
              ? "Download update…"
              : state.updates.status.kind === "ready"
                ? "Restart to update…"
                : "Check for updates…",
          enabled:
            state.updates.status.kind !== "disabled" && state.updates.status.kind !== "installing",
          click: () => {
            if (state.updates.status.kind === "ready") {
              requestRestart();
            } else {
              showHub();
              void (state.updates.status.kind === "available"
                ? updates.download()
                : updates.check());
            }
          },
        },
        { label: "Quit", role: "quit" },
      ]),
    );
  }
  refreshTray(store.state);

  store.subscribe((state, previous) => {
    publish({ hub, pill }, state, previous);
    if (state.session.phase === "starting" && previous.session.phase !== "starting") {
      positionPill(pill);
    }
    if (state.updates !== previous.updates) refreshTray(state);
    if (state.permissions !== previous.permissions) syncPermissionPolling();
    followSettings(cleanup, state, previous);
    followTransformSettings(transformModel, transforms, state, previous);
  });

  // A restart request holds the history still from the moment it starts draining it, so what it
  // checks is what the restart will leave behind.
  let restartRequested = false;
  function assertNotRestarting() {
    if (
      lifecycle !== "running" ||
      restartRequested ||
      store.state.updates.status.kind === "installing"
    )
      throw new Error("Voice is restarting.");
  }
  async function restartForUpdate(request: RestartRequest) {
    assertNotRestarting();
    restartRequested = true;
    try {
      // An accepted channel change must reach the updater before it installs.
      await settingsQueue.settled();
      await history.settled();
      const state = history.state();
      const refusal = restartRefusal(request, state);
      if (refusal) throw new Error(refusal);
      const [latest] = state.entries;
      await updates.restart(
        request.choice === "copyTranscriptAndRestart" && latest
          ? () => clipboard.writeText(copyText(latest))
          : undefined,
      );
    } finally {
      restartRequested = false;
    }
  }

  settingsQueue = createSettingsQueue({
    current: () => store.state.settings,
    save: async (next) => {
      try {
        await settingsFile.save(next);
      } catch (error) {
        log(`settings: save failed (${String(error)})`);
        throw new Error("Could not save this setting. Try again.", { cause: error });
      }
    },
    applied: (next, previous) => {
      store.update((s) => ({ ...s, settings: next }));
      syncHotkeys();
      if (next.microphone?.uid !== previous.microphone?.uid)
        helper.send({ type: "microphone.configure", microphone: next.microphone });
      if (next.theme !== previous.theme) nativeTheme.themeSource = next.theme;
      if (next.showInDock !== previous.showInDock) void syncDock();
      if (next.zoomLevel !== previous.zoomLevel && hub && !hub.isDestroyed())
        applyZoom(hub, next.zoomLevel);
    },
  });

  async function updateSettings(change: (settings: Settings) => Settings) {
    assertNotRestarting();
    const next = await settingsQueue.run(change);
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
      uninstall: async () => void helper.send({ type: "asr.remove" }),
    },
    cleanup: {
      install: () => void cleanup.install(),
      uninstall: () => cleanup.uninstall(),
    },
    transform: {
      install: () => void transformModel.install(),
      uninstall: () => transformModel.uninstall(),
    },
  };

  function assertCanUninstall(model: Model) {
    if (lifecycle !== "running") throw new Error("Voice is closing.");
    const { state } = store.state.models[model.id];
    if (state === "loading" || (state === "downloading" && !model.cancelableDownload)) {
      throw new Error(`Wait for the ${model.kind.toLowerCase()} to finish ${state}.`);
    }
    if (model.busyDuring && activity(store.state) === model.busyDuring) {
      throw new Error(
        `${FINISH_FIRST[model.busyDuring]}, then uninstall the ${model.kind.toLowerCase()}.`,
      );
    }
  }

  // Each window's handlers live on its own webContents.ipc, which Electron consults only for that
  // window's invokes. The Flow Bar cannot reach a hub command, and a recreated hub gets a new set.
  const pillCommands: Commands<PillApi> = pill.webContents.ipc;
  pillCommands.handle(Channel.getPillSnapshot, () => toPillSnapshot(toSnapshot(store.state)));

  const hubCommandDeps: HubCommandDeps = {
    store,
    development,
    running: () => lifecycle === "running",
    assertNotRestarting,
    updates,
    restartForUpdate,
    updateSettings,
    requestPermission,
    refreshLoginItem,
    microphoneTest,
    modelControls,
    assertCanUninstall,
    history,
    transforms,
    account,
    insights,
    installedApps,
    settingsQueue,
    log,
  };

  // A callback that changed the account brings the hub forward, but never mid-session: the
  // target app must keep focus until insertion. A launch by URL shows the hub anyway.
  handleCallbackUrl = (url) => {
    if (account.handleCallbackUrl(url) !== "ignored") runWhenIdle(showHub);
  };
  // Voice's own lock hands over a second copy's command line, which carries the callback URL
  // when the browser launched that copy.
  app.on("second-instance", (_event, argv) => {
    const url = callbackUrlFromArgv(argv);
    if (url) handleCallbackUrl(url);
    else showHub();
  });
  app.on("activate", showHub);
  Menu.setApplicationMenu(
    createApplicationMenu((step) => {
      updateSettings((current) =>
        applyPatch(current, { zoomLevel: nextZoomLevel(current.zoomLevel, step) }),
      ).catch(() => {});
    }),
  );
  // The tray keeps the app alive after the hub window closes.
  app.on("window-all-closed", () => {});

  // Electron quits without waiting on promises, so the first quit only starts the shutdown: a
  // settings save, the Insights and history writes, the helper, and the model processes get to
  // finish, and their logs get sent. The quit that follows it passes.
  async function shutdown(forUpdate = false) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS, "timeout");
    });
    transforms.dispose();
    const stopped = Promise.allSettled([
      settingsQueue.settled(),
      insights.settled(),
      history.settled(),
      helper.stop(),
      cleanup.dispose(),
      transformModel.dispose(),
    ]);
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
    account.dispose();
    stopPermissionPolling();
    void shutdown().then(() => {
      lifecycle = "stopped";
      app.quit();
    });
  });

  showHub();
  // The most recently launched Voice opens the link, so Stable, Nightly and a development build
  // each take it back when they start.
  if (receivesCallbackUrls() && !app.setAsDefaultProtocolClient(VOICE_URL_SCHEME)) {
    log(`account: could not become the ${VOICE_URL_SCHEME} handler`);
  }
  updates.start();
  void cleanup.loadIfDownloaded();
  void transformModel.refresh();
  // Lets scripts/quit-smoke.mjs start a cleanup through the inspector and quit during it, and the
  // verify skill deliver a sign-in callback URL, which macOS does not route to the stock
  // Electron.app the verify instance runs, and choose menu items, whose shortcuts CDP cannot press.
  if (testMode) {
    Object.assign(globalThis, {
      voiceTest: {
        cleanup,
        transformModel,
        openUrl: (url: string) => app.emit("open-url", { preventDefault() {} }, url),
        clickMenuItem: (id: string) => {
          const item = Menu.getApplicationMenu()?.getMenuItemById(id);
          if (!item) throw new Error(`no menu item ${id}`);
          item.click();
        },
        setTarget: (raw: unknown) => {
          const target = decodeTarget(raw);
          if (Option.isNone(target)) {
            throw new Error("setTarget takes null or { bundleId: string, host: string | null }");
          }
          helper.send({ type: "test.target", target: target.value });
        },
      },
    });
  }
}

// Called last because main runs synchronously until whenReady and reads module constants.
if (app.requestSingleInstanceLock()) {
  void main();
} else {
  app.exit(0);
}

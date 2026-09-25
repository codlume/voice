import * as NodePath from "node:path";

import { app, BrowserWindow, ipcMain, screen } from "electron";

import { Channel, type Snapshot } from "../shared/api.ts";

const PILL_WIDTH = 320;
const PILL_HEIGHT = 48;
const PILL_BOTTOM_MARGIN = 12;

const snapshot: Snapshot = {
  session: { kind: "idle" },
  permissions: { microphone: "notDetermined", accessibility: "notDetermined" },
  models: { asr: { state: "missing" }, cleanup: { state: "missing" } },
  settings: {
    hotkey: "fn",
    cleanup: { enabled: true, styling: "semi-casual", structure: "prose", context: "general" },
  },
  last: null,
};

const preload = NodePath.join(__dirname, "preload.cjs");

function loadPage(window: BrowserWindow, page: "hub" | "pill") {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void window.loadURL(new URL(`${page}.html`, devServerUrl).toString());
  } else {
    void window.loadFile(NodePath.join(__dirname, "../dist/renderer", `${page}.html`));
  }
}

let hub: BrowserWindow | undefined;

function showHub() {
  if (hub && !hub.isDestroyed()) {
    hub.show();
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
  loadPage(hub, "hub");
}

function createPillWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const pill = new BrowserWindow({
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    x: Math.round(workArea.x + (workArea.width - PILL_WIDTH) / 2),
    y: workArea.y + workArea.height - PILL_HEIGHT - PILL_BOTTOM_MARGIN,
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
}

ipcMain.handle(Channel.getSnapshot, () => snapshot);
ipcMain.handle(Channel.updateSettings, () => {});
ipcMain.handle(Channel.requestPermission, () => {});
ipcMain.handle(Channel.setupModels, () => {});
ipcMain.handle(Channel.copyLast, () => {});

void app.whenReady().then(() => {
  showHub();
  createPillWindow();
  app.on("activate", showHub);
});

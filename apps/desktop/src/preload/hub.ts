// Gives the renderer SDK its IPC channel to main. It stays inert unless main started Sentry.
import "@sentry/electron/preload";
import { contextBridge, ipcRenderer } from "electron";

import { Channel, DIAGNOSTICS_ARGUMENT, type HubApi, type Snapshot } from "../shared/api.ts";
import type { Insights } from "../shared/insights.ts";
import { subscribe } from "./subscribe.ts";

// The tray can ask before React has mounted, for example right after it creates the hub.
let restartRequested = false;
const restartListeners = new Set<() => void>();
ipcRenderer.on(Channel.requestRestart, () => {
  if (restartListeners.size === 0) restartRequested = true;
  for (const listener of restartListeners) listener();
});

const voice: HubApi = {
  diagnosticsStartedAtLaunch: process.argv.includes(DIAGNOSTICS_ARGUMENT),
  checkForUpdates: () => ipcRenderer.invoke(Channel.checkForUpdates),
  downloadUpdate: () => ipcRenderer.invoke(Channel.downloadUpdate),
  restartForUpdate: (request) => ipcRenderer.invoke(Channel.restartForUpdate, request),
  onRestartRequest: (listener) => {
    restartListeners.add(listener);
    if (restartRequested) {
      restartRequested = false;
      listener();
    }
    return () => restartListeners.delete(listener);
  },
  openRelease: () => ipcRenderer.invoke(Channel.openRelease),
  getSnapshot: () => ipcRenderer.invoke(Channel.getSnapshot),
  onSnapshot: (listener) => subscribe<Snapshot>(Channel.snapshot, listener),
  onLevel: (listener) => subscribe<number>(Channel.level, listener),
  updateSettings: (patch) => ipcRenderer.invoke(Channel.updateSettings, patch),
  requestPermission: (kind) => ipcRenderer.invoke(Channel.requestPermission, kind),
  setOpenAtLogin: (on) => ipcRenderer.invoke(Channel.setOpenAtLogin, on),
  startMicrophoneTest: () => ipcRenderer.invoke(Channel.startMicrophoneTest),
  stopMicrophoneTest: () => ipcRenderer.invoke(Channel.stopMicrophoneTest),
  installModel: (id) => ipcRenderer.invoke(Channel.installModel, id),
  uninstallModel: (id) => ipcRenderer.invoke(Channel.uninstallModel, id),
  copyLast: (which) => ipcRenderer.invoke(Channel.copyLast, which),
  signIn: () => ipcRenderer.invoke(Channel.signIn),
  signOut: () => ipcRenderer.invoke(Channel.signOut),
  submitSignInCode: (code) => ipcRenderer.invoke(Channel.submitSignInCode, code),
  cancelSignIn: () => ipcRenderer.invoke(Channel.cancelSignIn),
  dismissAccountError: () => ipcRenderer.invoke(Channel.dismissAccountError),
  updateAccountName: (name) => ipcRenderer.invoke(Channel.updateAccountName, name),
  requestAccountDeletion: () => ipcRenderer.invoke(Channel.requestAccountDeletion),
  confirmAccountDeletion: () => ipcRenderer.invoke(Channel.confirmAccountDeletion),
  cancelAccountDeletion: () => ipcRenderer.invoke(Channel.cancelAccountDeletion),
  retryAccountDeletion: () => ipcRenderer.invoke(Channel.retryAccountDeletion),
  getInsights: () => ipcRenderer.invoke(Channel.getInsights),
  onInsights: (listener) => subscribe<Insights>(Channel.insights, listener),
  clearInsights: () => ipcRenderer.invoke(Channel.clearInsights),
};

contextBridge.exposeInMainWorld("voice", voice);

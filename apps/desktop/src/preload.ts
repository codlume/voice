// Gives the renderer SDK its IPC channel to main. It stays inert unless main started Sentry.
import "@sentry/electron/preload";
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import {
  Channel,
  DIAGNOSTICS_ARGUMENT,
  type PillSnapshot,
  type Snapshot,
  type VoiceApi,
} from "./shared/api.ts";

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

// The tray can ask before React has mounted, for example right after it creates the hub.
let restartRequested = false;
const restartListeners = new Set<() => void>();
ipcRenderer.on(Channel.requestRestart, () => {
  if (restartListeners.size === 0) restartRequested = true;
  for (const listener of restartListeners) listener();
});

const voice: VoiceApi = {
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
  getPillSnapshot: () => ipcRenderer.invoke(Channel.getPillSnapshot),
  onPillSnapshot: (listener) => subscribe<PillSnapshot>(Channel.pillSnapshot, listener),
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
  requestAccountDeletion: () => ipcRenderer.invoke(Channel.requestAccountDeletion),
  confirmAccountDeletion: () => ipcRenderer.invoke(Channel.confirmAccountDeletion),
  cancelAccountDeletion: () => ipcRenderer.invoke(Channel.cancelAccountDeletion),
  retryAccountDeletion: () => ipcRenderer.invoke(Channel.retryAccountDeletion),
};

contextBridge.exposeInMainWorld("voice", voice);

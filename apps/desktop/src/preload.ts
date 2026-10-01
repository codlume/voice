// Gives the renderer SDK its IPC channel to main. It stays inert unless main started Sentry.
import "@sentry/electron/preload";
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import { Channel, DIAGNOSTICS_ARGUMENT, type Snapshot, type VoiceApi } from "./shared/api.ts";

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const voice: VoiceApi = {
  diagnosticsStartedAtLaunch: process.argv.includes(DIAGNOSTICS_ARGUMENT),
  checkForUpdates: () => ipcRenderer.invoke(Channel.checkForUpdates),
  restartForUpdate: () => ipcRenderer.invoke(Channel.restartForUpdate),
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
};

contextBridge.exposeInMainWorld("voice", voice);

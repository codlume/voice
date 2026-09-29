import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import { Channel, type Snapshot, type VoiceApi } from "./shared/api.ts";

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const voice: VoiceApi = {
  checkForUpdates: () => ipcRenderer.invoke(Channel.checkForUpdates),
  restartForUpdate: () => ipcRenderer.invoke(Channel.restartForUpdate),
  getSnapshot: () => ipcRenderer.invoke(Channel.getSnapshot),
  onSnapshot: (listener) => subscribe<Snapshot>(Channel.snapshot, listener),
  onLevel: (listener) => subscribe<number>(Channel.level, listener),
  updateSettings: (patch) => ipcRenderer.invoke(Channel.updateSettings, patch),
  requestPermission: (kind) => ipcRenderer.invoke(Channel.requestPermission, kind),
  startMicrophoneTest: () => ipcRenderer.invoke(Channel.startMicrophoneTest),
  stopMicrophoneTest: () => ipcRenderer.invoke(Channel.stopMicrophoneTest),
  setupModels: () => ipcRenderer.invoke(Channel.setupModels),
  copyLast: (which) => ipcRenderer.invoke(Channel.copyLast, which),
};

contextBridge.exposeInMainWorld("voice", voice);

// Gives the renderer SDK its IPC channel to main. It stays inert unless main started Sentry.
import "@sentry/electron/preload";
import { contextBridge, ipcRenderer } from "electron";

import { Channel, DIAGNOSTICS_ARGUMENT, type PillApi, type PillSnapshot } from "../shared/api.ts";
import { subscribe } from "./subscribe.ts";

const voice: PillApi = {
  diagnosticsStartedAtLaunch: process.argv.includes(DIAGNOSTICS_ARGUMENT),
  getPillSnapshot: () => ipcRenderer.invoke(Channel.getPillSnapshot),
  onPillSnapshot: (listener) => subscribe<PillSnapshot>(Channel.pillSnapshot, listener),
  onLevel: (listener) => subscribe<number>(Channel.level, listener),
  setPillClickable: (clickable) => ipcRenderer.invoke(Channel.setPillClickable, clickable),
  openNotepad: () => ipcRenderer.invoke(Channel.openNotepad),
};

contextBridge.exposeInMainWorld("voice", voice);

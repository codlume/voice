// Gives the renderer SDK its IPC channel to main. It stays inert unless main started Sentry.
import "@sentry/electron/preload";
import { contextBridge, ipcRenderer } from "electron";

import { Channel, DIAGNOSTICS_ARGUMENT, type HubApi, type Snapshot } from "../shared/api.ts";
import type { HistoryChange } from "../shared/history.ts";
import type { Insights } from "../shared/insights.ts";
import type {
  MeetingsChange,
  MeetingTranscriptChange,
  MeetingPartial,
} from "../shared/meetings.ts";
import type { LastTransform } from "../shared/transforms.ts";
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
  getHistory: () => ipcRenderer.invoke(Channel.getHistory),
  onHistory: (listener) => subscribe<HistoryChange>(Channel.history, listener),
  copyHistoryEntry: (id, version) => ipcRenderer.invoke(Channel.copyHistoryEntry, id, version),
  deleteHistoryEntry: (id) => ipcRenderer.invoke(Channel.deleteHistoryEntry, id),
  clearHistory: () => ipcRenderer.invoke(Channel.clearHistory),
  setHistoryRetention: (retention) => ipcRenderer.invoke(Channel.setHistoryRetention, retention),
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
  getInstalledApps: () => ipcRenderer.invoke(Channel.getInstalledApps),
  getAppIcons: (bundleIds) => ipcRenderer.invoke(Channel.getAppIcons, bundleIds),
  editAssignments: (edit) => ipcRenderer.invoke(Channel.editAssignments, edit),
  getLastTransform: () => ipcRenderer.invoke(Channel.getLastTransform),
  onLastTransform: (listener) => subscribe<LastTransform | null>(Channel.lastTransform, listener),
  copyLastTransform: (which) => ipcRenderer.invoke(Channel.copyLastTransform, which),
  getMeetings: () => ipcRenderer.invoke(Channel.getMeetings),
  onMeetings: (listener) => subscribe<MeetingsChange>(Channel.meetings, listener),
  getMeeting: (id) => ipcRenderer.invoke(Channel.getMeeting, id),
  renameMeeting: (id, title) => ipcRenderer.invoke(Channel.renameMeeting, id, title),
  renameMeetingSpeaker: (id, speakerId, name) =>
    ipcRenderer.invoke(Channel.renameMeetingSpeaker, id, speakerId, name),
  updateMeetingNotes: (id, notes) => ipcRenderer.invoke(Channel.updateMeetingNotes, id, notes),
  deleteMeeting: (id) => ipcRenderer.invoke(Channel.deleteMeeting, id),
  createFolder: (draft) => ipcRenderer.invoke(Channel.createFolder, draft),
  updateFolder: (id, draft) => ipcRenderer.invoke(Channel.updateFolder, id, draft),
  deleteFolder: (id) => ipcRenderer.invoke(Channel.deleteFolder, id),
  setMeetingInFolder: (meetingId, folderId, inFolder) =>
    ipcRenderer.invoke(Channel.setMeetingInFolder, meetingId, folderId, inFolder),
  searchMeetings: (query) => ipcRenderer.invoke(Channel.searchMeetings, query),
  updateMeetingsSettings: (patch) => ipcRenderer.invoke(Channel.updateMeetingsSettings, patch),
  copyMeetingMarkdown: (id) => ipcRenderer.invoke(Channel.copyMeetingMarkdown, id),
  exportMeetingMarkdown: (id) => ipcRenderer.invoke(Channel.exportMeetingMarkdown, id),
  startMeeting: () => ipcRenderer.invoke(Channel.startMeeting),
  toggleMeeting: () => ipcRenderer.invoke(Channel.toggleMeeting),
  pauseMeeting: (id) => ipcRenderer.invoke(Channel.pauseMeeting, id),
  resumeMeeting: (id) => ipcRenderer.invoke(Channel.resumeMeeting, id),
  stopMeeting: (id) => ipcRenderer.invoke(Channel.stopMeeting, id),
  keepMeeting: (id) => ipcRenderer.invoke(Channel.keepMeeting, id),
  discardMeeting: (id) => ipcRenderer.invoke(Channel.discardMeeting, id),
  generateMeetingSummary: (id) => ipcRenderer.invoke(Channel.generateMeetingSummary, id),
  retryMeetingTranscript: (id) => ipcRenderer.invoke(Channel.retryMeetingTranscript, id),
  deleteMeetingAudio: (id) => ipcRenderer.invoke(Channel.deleteMeetingAudio, id),
  openNotepad: () => ipcRenderer.invoke(Channel.openNotepad),
  onMeetingTranscript: (listener) =>
    subscribe<MeetingTranscriptChange>(Channel.meetingTranscript, listener),
  onMeetingPartial: (listener) => subscribe<MeetingPartial>(Channel.meetingPartial, listener),
  dismissMeetingNotice: (key) => ipcRenderer.invoke(Channel.dismissMeetingNotice, key),
};

contextBridge.exposeInMainWorld("voice", voice);

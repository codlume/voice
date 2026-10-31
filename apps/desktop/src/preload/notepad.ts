// Gives the renderer SDK its IPC channel to main. It stays inert unless main started Sentry.
import "@sentry/electron/preload";
import { contextBridge, ipcRenderer } from "electron";

import { Channel, DIAGNOSTICS_ARGUMENT, type NotepadApi } from "../shared/api.ts";
import type { MeetingPartial, MeetingTranscriptChange, NotepadState } from "../shared/meetings.ts";
import { subscribe } from "./subscribe.ts";

const voice: NotepadApi = {
  diagnosticsStartedAtLaunch: process.argv.includes(DIAGNOSTICS_ARGUMENT),
  getNotepad: () => ipcRenderer.invoke(Channel.getNotepad),
  onNotepad: (listener) => subscribe<NotepadState | null>(Channel.notepad, listener),
  dismissMeetingPrompt: () => ipcRenderer.invoke(Channel.dismissMeetingPrompt),
  viewMeetingSummary: (id) => ipcRenderer.invoke(Channel.viewMeetingSummary, id),
  getMeeting: (id) => ipcRenderer.invoke(Channel.getMeeting, id),
  updateMeetingNotes: (id, notes) => ipcRenderer.invoke(Channel.updateMeetingNotes, id, notes),
  pauseMeeting: (id) => ipcRenderer.invoke(Channel.pauseMeeting, id),
  resumeMeeting: (id) => ipcRenderer.invoke(Channel.resumeMeeting, id),
  stopMeeting: (id) => ipcRenderer.invoke(Channel.stopMeeting, id),
  keepMeeting: (id) => ipcRenderer.invoke(Channel.keepMeeting, id),
  discardMeeting: (id) => ipcRenderer.invoke(Channel.discardMeeting, id),
  onMeetingTranscript: (listener) =>
    subscribe<MeetingTranscriptChange>(Channel.meetingTranscript, listener),
  onMeetingPartial: (listener) => subscribe<MeetingPartial>(Channel.meetingPartial, listener),
};

contextBridge.exposeInMainWorld("voice", voice);

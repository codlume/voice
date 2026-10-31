import type { HubApi } from "../../shared/api.ts";
import {
  DEFAULT_MEETINGS_SETTINGS,
  liveMeeting,
  renameSpeaker,
  retitle,
  searchMeeting,
  type Folder,
  type FolderId,
  type Meeting,
  type MeetingCommandResult,
  type MeetingId,
  type MeetingPartial,
  type MeetingsChange,
  type MeetingsState,
  type MeetingTranscriptChange,
} from "../../shared/meetings.ts";
import type { MeetingFixtures } from "./meetingsFixtures.ts";

export type MeetingsApi = Pick<
  HubApi,
  Extract<keyof HubApi, `${string}Meeting${string}` | `${string}Folder${string}`>
>;

const empty: MeetingFixtures = {
  state: { meetings: [], folders: [], settings: DEFAULT_MEETINGS_SETTINGS },
  transcripts: {},
};

const ok = (id: MeetingId): MeetingCommandResult => ({ kind: "ok", id });
const refused = (message: string): MeetingCommandResult => ({ kind: "refused", message });

/** Closes the open leg, as Pause and Stop do in main. */
const closeLeg = (meeting: Meeting): Meeting =>
  meeting.status.kind === "recording"
    ? {
        ...meeting,
        spans: [...meeting.spans, { startedAt: meeting.status.since, endedAt: Date.now() }],
      }
    : meeting;

/**
 * Main's side of the Meetings page in memory, for the preview harness and the tests. It holds
 * what the page sets, publishes every change the way main does, and moves a meeting through
 * recording, paused and ready, so live states can be shown and driven.
 */
export function fakeMeetingsMain({ state: initial, transcripts }: MeetingFixtures = empty) {
  let state = initial;
  const listeners = new Set<(change: MeetingsChange) => void>();
  const lineListeners = new Set<(change: MeetingTranscriptChange) => void>();
  const partialListeners = new Set<(partial: MeetingPartial) => void>();
  const set = (next: Partial<MeetingsState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener({ kind: "all", state });
  };
  const find = (id: MeetingId) => state.meetings.find((meeting) => meeting.id === id);
  const editMeeting = (id: MeetingId, change: (meeting: Meeting) => Meeting) =>
    set({
      meetings: state.meetings.map((meeting) => (meeting.id === id ? change(meeting) : meeting)),
    });
  const editFolders = (change: (folders: readonly Folder[]) => readonly Folder[]) =>
    set({ folders: change(state.folders) });
  const live = () => liveMeeting(state.meetings);
  /** Moves the meeting on when `allowed` holds its status; refuses otherwise, as main does. */
  const step = (
    id: MeetingId,
    allowed: (meeting: Meeting) => boolean,
    next: (meeting: Meeting) => Meeting,
  ) => {
    const meeting = find(id);
    if (!meeting || !allowed(meeting)) return refused("The meeting cannot do that now.");
    editMeeting(id, next);
    return ok(id);
  };
  const start = (): MeetingCommandResult => {
    if (live()) return refused("A meeting is already recording.");
    const now = Date.now();
    const meeting: Meeting = {
      id: crypto.randomUUID() as MeetingId,
      title: null,
      createdAt: now,
      spans: [],
      status: { kind: "recording", since: now },
      folderIds: [],
      notes: "",
      summary: { kind: "none" },
      speakers: [],
      finalPassFailed: false,
    };
    set({ meetings: [meeting, ...state.meetings] });
    return ok(meeting.id);
  };
  const stop = (id: MeetingId) =>
    step(
      id,
      ({ status }) => status.kind === "recording" || status.kind === "paused",
      (meeting) => ({ ...closeLeg(meeting), status: { kind: "ready" } }),
    );

  const api: MeetingsApi = {
    getMeetings: async () => state,
    onMeetings: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getMeeting: async (id) => {
      const meeting = find(id);
      return meeting ? { meeting, transcript: transcripts[id] ?? [] } : null;
    },
    renameMeeting: async (id, title) =>
      editMeeting(id, (meeting) => retitle(meeting, title, state.folders, state.settings)),
    renameMeetingSpeaker: async (id, speakerId, name) =>
      editMeeting(id, (meeting) => renameSpeaker(meeting, speakerId, name)),
    updateMeetingNotes: async (id, notes) => editMeeting(id, (meeting) => ({ ...meeting, notes })),
    deleteMeeting: async (id) =>
      set({ meetings: state.meetings.filter((meeting) => meeting.id !== id) }),
    createFolder: async (draft) => {
      const folder: Folder = {
        ...draft,
        id: crypto.randomUUID() as FolderId,
        createdAt: Date.now(),
      };
      editFolders((folders) => [...folders, folder]);
      return folder;
    },
    updateFolder: async (id, draft) =>
      editFolders((folders) =>
        folders.map((folder) => (folder.id === id ? { ...folder, ...draft } : folder)),
      ),
    deleteFolder: async (id) =>
      editFolders((folders) => folders.filter((folder) => folder.id !== id)),
    setMeetingInFolder: async (meetingId, folderId, inFolder) =>
      editMeeting(meetingId, (meeting) => ({
        ...meeting,
        folderIds: inFolder
          ? [...new Set([...meeting.folderIds, folderId])]
          : meeting.folderIds.filter((id) => id !== folderId),
      })),
    searchMeetings: async (query) =>
      state.meetings.flatMap(
        (meeting) => searchMeeting(meeting, transcripts[meeting.id] ?? [], query) ?? [],
      ),
    updateMeetingsSettings: async (patch) => set({ settings: { ...state.settings, ...patch } }),
    copyMeetingMarkdown: async () => {},
    exportMeetingMarkdown: async () => "cancelled",
    startMeeting: async () => start(),
    toggleMeeting: async () => {
      const current = live();
      return current ? stop(current.id) : start();
    },
    pauseMeeting: async (id) =>
      step(
        id,
        ({ status }) => status.kind === "recording",
        (meeting) => ({ ...closeLeg(meeting), status: { kind: "paused" } }),
      ),
    resumeMeeting: async (id) =>
      step(
        id,
        ({ status }) => (status.kind === "paused" || status.kind === "ready") && !live(),
        (meeting) => ({ ...meeting, status: { kind: "recording", since: Date.now() } }),
      ),
    stopMeeting: async (id) => stop(id),
    keepMeeting: async (id) =>
      step(
        id,
        ({ status }) => status.kind === "confirmingShort",
        (meeting) => ({
          ...meeting,
          status: { kind: "ready" },
        }),
      ),
    discardMeeting: async (id) => {
      if (find(id)?.status.kind !== "confirmingShort") return refused("Nothing to discard.");
      set({ meetings: state.meetings.filter((meeting) => meeting.id !== id) });
      return ok(id);
    },
    generateMeetingSummary: async (id) =>
      step(
        id,
        ({ status }) => status.kind === "ready",
        (meeting) => ({ ...meeting, status: { kind: "summarizing", progress: null } }),
      ),
    retryMeetingTranscript: async (id) =>
      step(
        id,
        (meeting) => meeting.finalPassFailed,
        (meeting) => ({ ...meeting, finalPassFailed: false }),
      ),
    deleteMeetingAudio: async (id) =>
      step(
        id,
        (meeting) => meeting.finalPassFailed,
        (meeting) => ({ ...meeting, finalPassFailed: false }),
      ),
    onMeetingTranscript: (listener) => {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    onMeetingPartial: (listener) => {
      partialListeners.add(listener);
      return () => partialListeners.delete(listener);
    },
    dismissMeetingNotice: async () => {},
    onOpenMeeting: () => () => {},
    watchMeetingPermissions: async () => {},
  };

  return {
    api,
    /** Plays main publishing a new version of a meeting. */
    publish(changed: Meeting) {
      editMeeting(changed.id, () => changed);
    },
    /** Plays main pushing a saved line or an unconfirmed one to the open meeting. */
    push(event: MeetingTranscriptChange | MeetingPartial) {
      if ("entries" in event) for (const listener of lineListeners) listener(event);
      else for (const listener of partialListeners) listener(event);
    },
  };
}

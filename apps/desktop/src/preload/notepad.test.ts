import { describe, expect, test, vi } from "vite-plus/test";

import { Channel, type NotepadApi } from "../shared/api.ts";
import type { MeetingId } from "../shared/meetings.ts";

const listened: string[] = [];
const invoked: unknown[][] = [];
const exposures: { name: string; api: NotepadApi }[] = [];

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: NotepadApi) => {
      exposures.push({ name, api });
    },
  },
  ipcRenderer: {
    on: (channel: string) => listened.push(channel),
    off: () => {},
    invoke: (...args: unknown[]) => {
      invoked.push(args);
      return Promise.resolve();
    },
  },
}));
vi.mock("@sentry/electron/preload", () => ({}));

async function load() {
  await import("./notepad.ts");
  const [exposed] = exposures;
  if (!exposed) throw new Error("notepad preload exposed nothing");
  return exposed;
}

describe("notepad preload", () => {
  test("exposes only the notepad's members under voice", async () => {
    const { api } = await load();
    expect(exposures.map(({ name }) => name)).toEqual(["voice"]);
    expect(Object.keys(api).toSorted()).toEqual([
      "diagnosticsStartedAtLaunch",
      "discardMeeting",
      "dismissMeetingPrompt",
      "getMeeting",
      "getNotepad",
      "keepMeeting",
      "onMeetingTranscript",
      "onNotepad",
      "pauseMeeting",
      "resumeMeeting",
      "stopMeeting",
      "updateMeetingNotes",
    ]);
  });

  test("listens on nothing at import and only on its own channels once subscribed", async () => {
    const { api } = await load();
    expect(listened).toEqual([]);
    api.onNotepad(() => {});
    api.onMeetingTranscript(() => {});
    expect(new Set(listened)).toEqual(new Set([Channel.notepad, Channel.meetingTranscript]));
  });

  test("commands carry the meeting id on the shared meeting channels", async () => {
    const { api } = await load();
    invoked.length = 0;
    const id = "00000000-0000-4000-8000-000000000001" as MeetingId;
    await api.keepMeeting(id);
    await api.updateMeetingNotes(id, "Ask about pricing");
    await api.dismissMeetingPrompt();
    expect(invoked).toEqual([
      [Channel.keepMeeting, id],
      [Channel.updateMeetingNotes, id, "Ask about pricing"],
      [Channel.dismissMeetingPrompt],
    ]);
  });
});

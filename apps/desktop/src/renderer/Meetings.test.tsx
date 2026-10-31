// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { DEFAULT_SETTINGS, type HubApi, type Snapshot } from "../shared/api.ts";
import {
  DEFAULT_MEETINGS_SETTINGS,
  renameSpeaker,
  searchMeeting,
  type Folder,
  type FolderDraft,
  type FolderId,
  type Meeting,
  type MeetingId,
  type MeetingsChange,
  type MeetingsState,
  type MeetingPartial,
  type MeetingTranscriptChange,
  type OpenMeetingRequest,
  type Speaker,
  type SpeakerId,
  type TranscriptEntry,
} from "../shared/meetings.ts";
import { Meetings } from "./Meetings.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

const MINUTE = 60_000;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as MeetingId;
const hoursAgo = (hours: number) => Date.now() - hours * 3_600_000;

function meeting(
  n: number,
  title: string,
  startedAt: number,
  patch: Partial<Meeting> = {},
): Meeting {
  return {
    id: id(n),
    title: title,
    createdAt: startedAt,
    spans: [{ startedAt, endedAt: startedAt + 30 * MINUTE }],
    status: { kind: "ready" },
    folderIds: [],
    notes: "",
    summary: { kind: "none" },
    speakers: [],
    finalPassFailed: false,
    ...patch,
  };
}

const summary = (markdown: string) => ({
  kind: "ready" as const,
  summary: { markdown, coversUntilMs: 30 * MINUTE },
});

const PRIYA = "s1" as SpeakerId;
const TOM = "s2" as SpeakerId;
const syncSpeakers: Speaker[] = [
  { id: PRIYA, label: "Speaker 1", name: "Priya Shah" },
  { id: TOM, label: "Speaker 2", name: null },
];
const syncSummary =
  "{{speaker:s1}} agreed to ship the export fix.\n\n### Decisions\n- Ship on Thursday\n\n### Next Steps\n- **{{speaker:s2}}**\n  - Draft the launch email";

const transcript: TranscriptEntry[] = [
  {
    kind: "segment",
    id: "a",
    startMs: 0,
    endMs: 1,
    text: "Morning all",
    source: "mic",
  },
  { kind: "marker", marker: "dictated", atMs: 2000 },
  {
    kind: "segment",
    id: "b",
    startMs: 3000,
    endMs: 4000,
    text: "The export bug is fixed",
    source: "system",
    speakerId: PRIYA,
  },
  {
    kind: "segment",
    id: "c",
    startMs: 5000,
    endMs: 6000,
    text: "I will draft the email",
    source: "system",
    speakerId: TOM,
  },
];

// Set up, with the summary model on disk, so only tests about those show them.
const setUp: Snapshot = {
  microphones: { kind: "loading" },
  microphoneTest: { kind: "off" },
  updates: {
    version: "0.0.1",
    installedChannel: "stable",
    channel: "stable",
    status: { kind: "idle" },
  },
  session: { kind: "idle" },
  permissions: { microphone: "granted", accessibility: "granted", systemAudio: "granted" },
  loginItem: "off",
  models: {
    asr: { state: "ready" },
    cleanup: { state: "ready" },
    transform: { state: "installed" },
  },
  settings: DEFAULT_SETTINGS,
  account: { kind: "signedOut" },
  meetingNotices: [],
};

// Holds state like main and publishes every change; spies record the commands.
function fakeMain(meetings: Meeting[], folders: Folder[] = []) {
  let state: MeetingsState = { meetings, folders, settings: DEFAULT_MEETINGS_SETTINGS };
  const listeners = new Set<(change: MeetingsChange) => void>();
  const set = (next: Partial<MeetingsState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener({ kind: "all", state });
  };
  const transcripts: Record<string, TranscriptEntry[]> = { [id(1)]: transcript };
  const live = {
    transcript: new Set<(change: MeetingTranscriptChange) => void>(),
    partial: new Set<(partial: MeetingPartial) => void>(),
  };
  const api = {
    getMeetings: async () => state,
    onMeetings: (listener: (change: MeetingsChange) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getMeeting: async (meetingId: MeetingId) => {
      const found = state.meetings.find((candidate) => candidate.id === meetingId);
      return found ? { meeting: found, transcript: transcripts[meetingId] ?? [] } : null;
    },
    searchMeetings: vi.fn(async (query: string) =>
      state.meetings.flatMap((m) => searchMeeting(m, transcripts[m.id] ?? [], query) ?? []),
    ),
    onMeetingTranscript: (listener: (change: MeetingTranscriptChange) => void) => {
      live.transcript.add(listener);
      return () => live.transcript.delete(listener);
    },
    onMeetingPartial: (listener: (partial: MeetingPartial) => void) => {
      live.partial.add(listener);
      return () => live.partial.delete(listener);
    },
    renameMeetingSpeaker: vi.fn(async (meetingId: MeetingId, speakerId: SpeakerId, name: string) =>
      set({
        meetings: state.meetings.map((m) =>
          m.id === meetingId ? renameSpeaker(m, speakerId, name) : m,
        ),
      }),
    ),
    updateMeetingNotes: vi.fn(async (meetingId: MeetingId, notes: string) =>
      set({ meetings: state.meetings.map((m) => (m.id === meetingId ? { ...m, notes } : m)) }),
    ),
    deleteMeeting: vi.fn(async (meetingId: MeetingId) =>
      set({ meetings: state.meetings.filter((m) => m.id !== meetingId) }),
    ),
    createFolder: vi.fn(async (draft: FolderDraft) => {
      const folder = { ...draft, id: crypto.randomUUID() as FolderId, createdAt: 0 } as Folder;
      set({ folders: [...state.folders, folder] });
      return folder;
    }),
    updateFolder: vi.fn(async (folderId: FolderId, draft: FolderDraft) =>
      set({ folders: state.folders.map((f) => (f.id === folderId ? { ...f, ...draft } : f)) }),
    ),
    deleteFolder: vi.fn(async (folderId: FolderId) =>
      set({ folders: state.folders.filter((f) => f.id !== folderId) }),
    ),
    updateMeetingsSettings: vi.fn(async () => {}),
    requestPermission: vi.fn(async () => {}),
    installModel: vi.fn(async () => {}),
    generateMeetingSummary: vi.fn(async (meetingId: MeetingId) => {
      const index = state.meetings.findIndex((m) => m.id === meetingId);
      const summarizing = {
        ...state.meetings[index]!,
        status: { kind: "summarizing" as const, progress: null },
      };
      set({ meetings: state.meetings.with(index, summarizing) });
      return { kind: "ok", id: meetingId } as const;
    }),
    startMeeting: vi.fn(
      async () => ({ kind: "refused", message: "Recording did not start." }) as const,
    ),
  };
  (window as { voice?: HubApi }).voice = {
    getSnapshot: () => Promise.reject(new Error("not needed")),
    ...api,
  } as Partial<HubApi> as HubApi;
  return {
    ...api,
    /** Plays main publishing a new version of a meeting. */
    publish(changed: Meeting) {
      set({ meetings: state.meetings.map((m) => (m.id === changed.id ? changed : m)) });
    },
    /** Plays main pushing a saved line or an unconfirmed one to the open meeting. */
    async push(event: MeetingTranscriptChange | MeetingPartial) {
      await act(async () => {
        if ("entries" in event) for (const listener of live.transcript) listener(event);
        else for (const listener of live.partial) listener(event);
      });
    },
  };
}

const lineClass = (said: string) =>
  [...document.querySelectorAll("li p")].find((p) => p.textContent === said)?.className;

function Page({
  snapshot,
  request = null,
}: {
  snapshot: Snapshot;
  request?: OpenMeetingRequest | null;
}) {
  const [open, setOpen] = useState(false);
  return <Meetings snapshot={snapshot} settings={{ open, setOpen }} request={request} />;
}

async function render(snapshot: Snapshot = setUp) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Page snapshot={snapshot} />));
  await settle();
}

const settle = () => act(async () => {});
const text = () => document.body.textContent ?? "";
const waitForText = (needle: string) =>
  vi.waitFor(
    async () => {
      await settle();
      expect(text()).toContain(needle);
    },
    { timeout: 2000 },
  );

function byText(needle: string, selector = "button, [role=tab], [role=radio]"): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>(selector)].find(
    (element) => element.textContent?.trim() === needle,
  );
  if (!found) throw new Error(`no ${selector} reads “${needle}”`);
  return found;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    (element as HTMLElement).click();
  });
  await settle();
}

async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = Object.getPrototypeOf(element) as object;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const sample = () => [
  meeting(1, "Weekly product sync", hoursAgo(0), {
    summary: summary(syncSummary),
    speakers: syncSpeakers,
  }),
  meeting(2, "Planowanie sprintu", hoursAgo(26)),
  meeting(3, "Morning standup", hoursAgo(27)),
];

describe("Past notes", () => {
  test("groups meetings under their day", async () => {
    fakeMain(sample());
    await render();
    const days = [...document.querySelectorAll("section[aria-label]")].map((section) => ({
      day: section.querySelector("h3")?.textContent,
      titles: [...section.querySelectorAll("li > div > button")].map((b) => b.textContent),
    }));
    expect(days[0]).toEqual({ day: "Today", titles: ["Weekly product sync"] });
    expect(days.flatMap(({ titles }) => titles)).toEqual([
      "Weekly product sync",
      "Planowanie sprintu",
      "Morning standup",
    ]);
    expect(days.length).toBeGreaterThan(1);
  });

  test("the panel shows the overview with speaker names highlighted", async () => {
    fakeMain(sample());
    await render();
    const panel = document.querySelector("aside[aria-label='Meeting overview']")!;
    expect(panel.querySelector("h2")?.textContent).toBe("Weekly product sync");
    await waitForText("Overview");
    await vi.waitFor(async () => {
      await settle();
      expect(panel.querySelector("mark")?.textContent).toBe("Priya Shah");
    });
    expect(panel.textContent).toContain("agreed to ship the export fix.");
    expect(panel.textContent).not.toContain("Decisions");
  });

  test("the overview shows a rename at once, from the same summary", async () => {
    const main = fakeMain(sample());
    await render();
    const panel = document.querySelector("aside[aria-label='Meeting overview']")!;
    await waitForText("Overview");

    await act(() => main.renameMeetingSpeaker(id(1), PRIYA, "Priya S."));

    await vi.waitFor(() => expect(panel.querySelector("mark")?.textContent).toBe("Priya S."));
    expect(panel.textContent).not.toContain("{{speaker:");
  });

  test("search shows where each meeting matched, and says when nothing does", async () => {
    const main = fakeMain(sample());
    await render();
    const search = document.querySelector<HTMLInputElement>("input[type=search]")!;
    await type(search, "export bug");
    await waitForText("Transcript: Morning all The export bug is fixed");
    expect(main.searchMeetings).toHaveBeenLastCalledWith("export bug");
    expect(document.querySelectorAll("li").length).toBe(1);
    await type(search, "zzz");
    await waitForText("No meetings match “zzz”.");
  });

  test("without meetings it says how to start, with no calendar talk", async () => {
    fakeMain([]);
    await render();
    expect(text()).toContain("No meetings yet");
    expect(text().toLowerCase()).not.toContain("calendar");
    expect(document.querySelector("aside")).toBeNull();
  });

  test("Start meeting says why main refused", async () => {
    const main = fakeMain([]);
    await render();
    await click(document.querySelector("h1")!.parentElement!.querySelector("button:last-child")!);
    expect(main.startMeeting).toHaveBeenCalledOnce();
    expect(document.querySelector("[role=status]")?.textContent).toBe("Recording did not start.");
  });
});

describe("meeting notices", () => {
  test("show on the page with their meeting, open it, and dismiss through main", async () => {
    fakeMain(sample());
    const dismissMeetingNotice = vi.fn(async () => {});
    window.voice = { ...window.voice, dismissMeetingNotice } as HubApi;
    await render({
      ...setUp,
      meetingNotices: [
        {
          key: 2,
          id: id(1),
          text: "The summary could not be written.",
          actions: [],
          dismissable: true,
        },
        { key: 1, id: id(9), text: "Recording did not start.", actions: [], dismissable: true },
      ],
    });
    const notices = [...document.querySelectorAll("[role=status]")].map((p) => p.textContent);
    expect(notices).toEqual([
      "Weekly product sync The summary could not be written.",
      "Recording did not start.",
    ]);
    await click(byText("Dismiss"));
    expect(dismissMeetingNotice).toHaveBeenCalledWith(2);
    await click(byText("Open"));
    await waitForText("All meetings");
    expect(text()).toContain("The summary could not be written.");
    expect(text()).not.toContain("Recording did not start.");
  });
});

describe("a failed final pass", () => {
  test("offers to try again or delete the kept audio, and cannot be dismissed", async () => {
    fakeMain(sample());
    const retryMeetingTranscript = vi.fn(
      async (meetingId: MeetingId) => ({ kind: "ok", id: meetingId }) as const,
    );
    const deleteMeetingAudio = vi.fn(
      async () => ({ kind: "refused", message: "There is no kept audio to delete." }) as const,
    );
    window.voice = { ...window.voice, retryMeetingTranscript, deleteMeetingAudio } as HubApi;
    await render({
      ...setUp,
      meetingNotices: [
        {
          key: 3,
          id: id(1),
          text: "The final transcript could not be made.",
          actions: ["retryFinalPass", "deleteAudio"],
          dismissable: false,
        },
      ],
    });
    expect(text()).not.toContain("Dismiss");
    await click(byText("Try again"));
    expect(retryMeetingTranscript).toHaveBeenCalledWith(id(1));
    await click(byText("Delete audio"));
    expect(deleteMeetingAudio).toHaveBeenCalledWith(id(1));
    await waitForText("There is no kept audio to delete.");
  });
});

describe("a ready summary", () => {
  test("main's request opens its meeting on the Summary tab, even over another tab", async () => {
    fakeMain(sample());
    await render();
    await click(byText("Weekly product sync"));
    await waitForText("All meetings");
    await click(byText("Transcript"));
    const request: OpenMeetingRequest = { id: id(1), tab: "summary" };
    await act(async () => root!.render(<Page snapshot={setUp} request={request} />));
    await waitForText("Next Steps");
    const selected = document.querySelector("[role=tab][aria-selected=true]");
    expect(selected?.textContent).toBe("Summary");
  });
});

describe("a meeting's recording controls", () => {
  async function open(status: Meeting["status"]) {
    fakeMain([meeting(1, "Weekly product sync", hoursAgo(0), { status })]);
    const commands = {
      resumeMeeting: vi.fn(
        async (meetingId: MeetingId) => ({ kind: "ok", id: meetingId }) as const,
      ),
      keepMeeting: vi.fn(async (meetingId: MeetingId) => ({ kind: "ok", id: meetingId }) as const),
      discardMeeting: vi.fn(
        async (meetingId: MeetingId) => ({ kind: "ok", id: meetingId }) as const,
      ),
      pauseMeeting: vi.fn(
        async () => ({ kind: "refused", message: "The meeting is not recording." }) as const,
      ),
      stopMeeting: vi.fn(async (meetingId: MeetingId) => ({ kind: "ok", id: meetingId }) as const),
    };
    window.voice = { ...window.voice, ...commands } as HubApi;
    await render();
    await click(byText("Weekly product sync"));
    await waitForText("All meetings");
    return commands;
  }

  test("a finished meeting resumes into itself, and can be deleted", async () => {
    const commands = await open({ kind: "ready" });
    await click(byText("Resume recording"));
    expect(commands.resumeMeeting).toHaveBeenCalledWith(id(1));
    expect(document.querySelector("[aria-label='Delete meeting']")).not.toBeNull();
  });

  test("a meeting asking whether it started by mistake is kept or discarded from the page", async () => {
    const commands = await open({ kind: "confirmingShort" });
    expect(text()).toContain("Started by mistake?");
    await click(byText("Keep"));
    expect(commands.keepMeeting).toHaveBeenCalledWith(id(1));
    await click(byText("Discard"));
    expect(commands.discardMeeting).toHaveBeenCalledWith(id(1));
  });

  test("a live meeting pauses and stops from the page, shows why a command did nothing, and cannot be deleted", async () => {
    const commands = await open({ kind: "recording", since: hoursAgo(0) });
    expect(document.querySelector("[aria-label='Delete meeting']")).toBeNull();
    await click(byText("Pause"));
    await waitForText("The meeting is not recording.");
    await click(byText("Stop"));
    expect(commands.stopMeeting).toHaveBeenCalledWith(id(1));
  });

  test("a summary in progress shows its step", async () => {
    await open({ kind: "summarizing", progress: { step: 2, total: 3 } });
    expect(text()).toContain("Writing the summary… Step 2 of 3.");
  });
});

describe("a meeting", () => {
  async function openSync() {
    const main = fakeMain(sample());
    await render();
    await click(byText("Weekly product sync"));
    await waitForText("All meetings");
    return main;
  }

  test("shows its summary, thoughts and transcript tabs", async () => {
    await openSync();
    expect(
      document.querySelector<HTMLInputElement>("input[aria-label='Meeting title']")?.value,
    ).toBe("Weekly product sync");
    await waitForText("Next Steps");
    await vi.waitFor(async () => {
      await settle();
      expect(document.querySelector("mark")?.textContent).toBe("Priya Shah");
    });
    await click(byText("Transcript"));
    await waitForText("Dictated at 00:02");
    expect(text()).toContain("You");
    expect(text()).toContain("The export bug is fixed");
    await click(byText("My thoughts"));
    expect(document.querySelector("textarea[aria-label='My thoughts']")).not.toBeNull();
  });

  test("renaming a speaker shows the name in the transcript and the summary", async () => {
    const main = await openSync();
    await waitForText("Speaker 2");
    await click(byText("Transcript"));
    await waitForText("I will draft the email");
    const field = document.querySelector<HTMLInputElement>(
      "input[aria-label='Name for Speaker 2']",
    )!;
    await act(async () => field.focus());
    await type(field, "Tom Becker");
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(main.renameMeetingSpeaker).toHaveBeenCalledWith(id(1), TOM, "Tom Becker");
    await waitForText("Tom Becker");
    expect(text()).not.toContain("Speaker 2I will draft");
    await click(byText("Summary"));
    await vi.waitFor(async () => {
      await settle();
      const marks = [...document.querySelectorAll("mark")].map((mark) => mark.textContent);
      expect(marks).toEqual(["Priya Shah", "Tom Becker"]);
    });
  });

  test("while it records, saved lines append and unconfirmed text shows in gray until replaced", async () => {
    const recording = meeting(4, "Live sync", hoursAgo(0), {
      spans: [],
      status: { kind: "recording", since: Date.now() },
    });
    const main = fakeMain([recording]);
    await render();
    await click(byText("Live sync"));
    await click(byText("Transcript"));
    await waitForText("No transcript yet.");
    await main.push({ id: id(4), source: "system", text: "so the export" });
    await waitForText("so the export");
    expect(text()).toContain("Others");
    await main.push({
      id: id(4),
      entries: [
        {
          kind: "segment",
          id: "x",
          startMs: 0,
          endMs: 1000,
          text: "So the export works.",
          source: "system",
          speakerId: null,
        },
      ],
    });
    await main.push({ id: id(4), source: "system", text: "" });
    await waitForText("So the export works.");
    expect(text()).not.toContain("so the export");
    await main.push({ id: id(4), source: "mic", text: "and the import" });
    await waitForText("and the import");
    expect(lineClass("and the import")).not.toBe(lineClass("So the export works."));
  });

  test("a line saved while the meeting is read again still shows, without reopening", async () => {
    const live = meeting(4, "Live sync", hoursAgo(0), {
      spans: [],
      status: { kind: "recording", since: Date.now() },
    });
    const main = fakeMain([live]);
    await render();
    await click(byText("Live sync"));
    await click(byText("Transcript"));
    await waitForText("No transcript yet.");
    // Main read the transcript file before the line was written, and answers after pushing it.
    const answers: (() => void)[] = [];
    const read = window.voice as HubApi;
    const getMeeting = read.getMeeting;
    read.getMeeting = (meetingId) =>
      getMeeting(meetingId).then(
        (detail) => new Promise((resolve) => answers.push(() => resolve(detail))),
      );
    await act(async () => main.publish({ ...live, notes: "edited in the notepad" }));
    await main.push({
      id: id(4),
      entries: [
        {
          kind: "segment",
          id: "y",
          startMs: 0,
          endMs: 1000,
          text: "Pushed during the read.",
          source: "mic",
        },
      ],
    });
    await act(async () => answers.forEach((answer) => answer()));
    await waitForText("Pushed during the read.");
  });

  test("saves thoughts once typing pauses, and again on leaving", async () => {
    const main = await openSync();
    await click(byText("My thoughts"));
    const area = document.querySelector<HTMLTextAreaElement>("textarea")!;
    await type(area, "Ask Tom");
    await type(area, "Ask Tom about drivers");
    await vi.waitFor(
      async () => {
        await settle();
        expect(main.updateMeetingNotes).toHaveBeenCalledOnce();
      },
      { timeout: 2000 },
    );
    expect(main.updateMeetingNotes).toHaveBeenCalledWith(id(1), "Ask Tom about drivers");
    await type(area, "Ask Tom about drivers today");
    await click(byText("All meetings"));
    expect(main.updateMeetingNotes).toHaveBeenLastCalledWith(id(1), "Ask Tom about drivers today");
  });

  test("asks before deleting, then returns to the list", async () => {
    const main = await openSync();
    await click(document.querySelector("[aria-label='Delete meeting']")!);
    await waitForText("Delete “Weekly product sync”?");
    expect(main.deleteMeeting).not.toHaveBeenCalled();
    await click(byText("Delete"));
    expect(main.deleteMeeting).toHaveBeenCalledWith(id(1));
    await waitForText("Past notes");
    expect(text()).not.toContain("Weekly product sync");
  });

  test("a short meeting offers Generate summary, which asks main for it", async () => {
    const main = fakeMain(sample());
    await render();
    await click(byText("Morning standup"));
    await waitForText("Generate summary");
    await click(byText("Generate summary"));
    expect(main.generateMeetingSummary).toHaveBeenCalledWith(id(3));
    await waitForText("Writing the summary…");
  });

  test("a long meeting without a summary offers one in words that fit its length and state", async () => {
    const stored = meeting(5, "Planning", hoursAgo(1));
    const transcribing = meeting(6, "Retro", hoursAgo(2), {
      status: { kind: "transcribing", step: "finalizing" },
    });
    const main = fakeMain([stored, transcribing]);
    await render();
    await click(byText("Planning"));
    await waitForText("This meeting has no summary yet.");
    expect(text()).not.toContain("Short meetings");
    await click(byText("Generate summary"));
    expect(main.generateMeetingSummary).toHaveBeenCalledWith(id(5));
    await click(byText("All meetings"));
    await click(byText("Retro"));
    await waitForText("The summary is written once the transcript is final.");
  });

  test("a summary that needed the missing model offers its download above the failure", async () => {
    const meetings = sample();
    const message = "Download the summary model, then try again.";
    meetings[2] = { ...meetings[2]!, summary: { kind: "failed", message, previous: null } };
    const main = fakeMain(meetings);
    await render({ ...setUp, models: { ...setUp.models, transform: { state: "missing" } } });
    await click(byText("Morning standup"));
    await waitForText("Download the summary model, then try again.");
    expect(text()).toContain("Summaries use Gemma 4 E2B by Google (3.1 GB).");
    await click(byText("Download"));
    expect(main.installModel).toHaveBeenCalledWith("transform");
  });
});

describe("Folders", () => {
  test("creates, renames and deletes folders", async () => {
    const main = fakeMain(sample());
    await render();
    await click(byText("Folders"));
    await waitForText("No folders yet");

    await click(byText("New folder"));
    await click(byText("Automatic"));
    const [name, keyword] = document.querySelectorAll<HTMLInputElement>(
      "[role=dialog] input[placeholder]",
    );
    await type(name!, "Standups");
    await type(keyword!, "standup");
    await click(byText("Create folder"));
    expect(main.createFolder).toHaveBeenCalledWith({
      name: "Standups",
      kind: "auto",
      rule: { kind: "titleContains", text: "standup" },
    });
    await waitForText("Automatic: title contains “standup”");

    await click(document.querySelector("[aria-label='Edit folder Standups']")!);
    const renamed = document.querySelector<HTMLInputElement>("[role=dialog] input[placeholder]")!;
    await type(renamed, "Daily standups");
    await click(byText("Save"));
    expect(main.updateFolder).toHaveBeenCalledWith(expect.any(String), {
      name: "Daily standups",
      kind: "auto",
      rule: { kind: "titleContains", text: "standup" },
    });

    await click(document.querySelector("[aria-label='Delete folder Daily standups']")!);
    await waitForText("Only the folder is deleted. Its meetings stay.");
    await click(byText("Delete folder"));
    expect(main.deleteFolder).toHaveBeenCalledOnce();
    await waitForText("No folders yet");
  });

  test("an automatic folder needs a word to look for", async () => {
    const main = fakeMain([]);
    await render();
    await click(byText("Folders"));
    await click(byText("New folder"));
    await click(byText("Automatic"));
    await type(
      document.querySelector<HTMLInputElement>("[role=dialog] input[placeholder]")!,
      "Standups",
    );
    await click(byText("Create folder"));
    expect(main.createFolder).not.toHaveBeenCalled();
    expect(text()).toContain("Enter a word to look for in titles.");
  });
});

test("the settings say how long transcripts are kept", async () => {
  fakeMain(sample());
  await render();
  await click(document.querySelector("[aria-label='Meeting settings']")!);
  await waitForText("Keep meetings");
  expect(text()).toContain(
    "Transcripts, summaries and your thoughts stay on this Mac until you delete them.",
  );
});

describe("Set up Meetings", () => {
  test("a new Mac asks for both permissions and a first meeting, and Grant asks macOS", async () => {
    const main = fakeMain([]);
    await render({
      ...setUp,
      permissions: { microphone: "notDetermined", accessibility: "granted", systemAudio: "denied" },
    });
    expect(text()).toContain("Set up Meetings0 of 3 done");
    expect(text()).toContain("System Audio RecordingHears the other participants");
    expect(text()).toContain("Allow Voice in System Settings");
    expect(text()).toContain("Click Start meeting or press ⌥M, talk a little, then stop");
    expect(text()).toContain("Always get consent before recording others.");
    await click(byText("Grant"));
    expect(main.requestPermission).toHaveBeenCalledWith("microphone");
    await click(byText("Open"));
    expect(main.requestPermission).toHaveBeenLastCalledWith("systemAudio");
  });

  test("below macOS 14.4 it says only the microphone is recorded and goes once a meeting exists", async () => {
    const unavailable: Snapshot = {
      ...setUp,
      permissions: { ...setUp.permissions, systemAudio: "unavailable" },
    };
    fakeMain([]);
    await render(unavailable);
    expect(text()).toContain("Meetings record only your microphone on this Mac");
    expect(text()).toContain("Needs macOS 14.4 or later");
    expect(text()).toContain("2 of 3 done");
    await act(async () => root?.unmount());
    document.body.replaceChildren();

    fakeMain(sample());
    await render(unavailable);
    expect(text()).not.toContain("Set up Meetings");
  });

  test("without the summary model the page offers its download and still lists meetings", async () => {
    const main = fakeMain(sample());
    await render({ ...setUp, models: { ...setUp.models, transform: { state: "missing" } } });
    expect(text()).toContain("Summaries use Gemma 4 E2B by Google (3.1 GB). Transcripts work");
    expect(text()).toContain("Weekly product sync");
    expect(text()).not.toContain("Set up Meetings");
    await click(byText("Download"));
    expect(main.installModel).toHaveBeenCalledWith("transform");
  });
});

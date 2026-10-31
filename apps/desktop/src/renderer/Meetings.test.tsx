// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { HubApi } from "../shared/api.ts";
import {
  DEFAULT_MEETINGS_SETTINGS,
  searchMeeting,
  type Folder,
  type FolderDraft,
  type FolderId,
  type Meeting,
  type MeetingId,
  type MeetingsChange,
  type MeetingsState,
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
    title: { text: title, source: "user" },
    createdAt: startedAt,
    spans: [{ startedAt, endedAt: startedAt + 30 * MINUTE }],
    status: { kind: "ready" },
    folderIds: [],
    notes: "",
    summary: { kind: "none" },
    ...patch,
  };
}

const summary = (markdown: string) => ({
  kind: "ready" as const,
  summary: { markdown, generatedAt: 0, coversUntilMs: 30 * MINUTE },
});

const syncSummary =
  "Priya Shah agreed to ship the export fix.\n\n### Decisions\n- Ship on Thursday\n\n### Next Steps\n- **Priya Shah**\n  - Draft the launch email";

const transcript: TranscriptEntry[] = [
  {
    kind: "segment",
    id: "a",
    startMs: 0,
    endMs: 1,
    text: "Morning all",
    final: true,
    source: "mic",
  },
  { kind: "marker", marker: "dictated", atMs: 2000 },
  {
    kind: "segment",
    id: "b",
    startMs: 3000,
    endMs: 4000,
    text: "The export bug is fixed",
    final: true,
    source: "system",
    speaker: "Priya Shah",
  },
];

// Holds state like main and publishes every change; spies record the commands.
function fakeMain(meetings: Meeting[], folders: Folder[] = []) {
  let state: MeetingsState = { meetings, folders, settings: DEFAULT_MEETINGS_SETTINGS };
  const listeners = new Set<(change: MeetingsChange) => void>();
  const set = (next: Partial<MeetingsState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener({ kind: "all", state });
  };
  const transcripts: Record<string, TranscriptEntry[]> = { [id(1)]: transcript };
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
    startMeeting: vi.fn(async () => ({ kind: "unavailable" }) as const),
  };
  (window as { voice?: HubApi }).voice = {
    getSnapshot: () => Promise.reject(new Error("not needed")),
    ...api,
  } as Partial<HubApi> as HubApi;
  return api;
}

async function render() {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Meetings />));
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
  meeting(1, "Weekly product sync", hoursAgo(0), { summary: summary(syncSummary) }),
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

  test("Start meeting explains that recording is not available yet", async () => {
    const main = fakeMain([]);
    await render();
    await click(document.querySelector("h1")!.parentElement!.querySelector("button:last-child")!);
    expect(main.startMeeting).toHaveBeenCalledOnce();
    expect(document.querySelector("[role=status]")?.textContent).toMatch(/not available/);
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

  test("a short meeting offers Generate summary", async () => {
    fakeMain(sample());
    await render();
    await click(byText("Morning standup"));
    await waitForText("Generate summary");
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

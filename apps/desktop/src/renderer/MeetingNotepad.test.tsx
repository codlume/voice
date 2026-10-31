// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { NotepadApi } from "../shared/api.ts";
import type {
  Meeting,
  MeetingId,
  MeetingTranscriptChange,
  NotepadState,
  TranscriptEntry,
} from "../shared/meetings.ts";
import { Notepad } from "./MeetingNotepad.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const id = "00000000-0000-4000-8000-000000000001" as MeetingId;
const meeting: Meeting = {
  id,
  title: null,
  createdAt: 0,
  spans: [],
  status: { kind: "recording", since: Date.now() },
  folderIds: [],
  notes: "",
  summary: { kind: "none" },
};

const said = (segmentId: string, text: string, source: "mic" | "system"): TranscriptEntry =>
  source === "mic"
    ? { kind: "segment", id: segmentId, startMs: 0, endMs: 1, text, final: true, source }
    : {
        kind: "segment",
        id: segmentId,
        startMs: 0,
        endMs: 1,
        text,
        final: true,
        source,
        speaker: null,
      };

function fakeNotepad(first: NotepadState, transcript: TranscriptEntry[] = []) {
  const notepadListeners = new Set<(state: NotepadState | null) => void>();
  const transcriptListeners = new Set<(change: MeetingTranscriptChange) => void>();
  const ok = async () => ({ kind: "ok", id }) as const;
  const api = {
    diagnosticsStartedAtLaunch: false,
    getNotepad: async () => first,
    onNotepad: (listener) => {
      notepadListeners.add(listener);
      return () => notepadListeners.delete(listener);
    },
    dismissMeetingPrompt: vi.fn(async () => {}),
    getMeeting: async () => ({ meeting: first.meeting, transcript }),
    updateMeetingNotes: vi.fn(async () => {}),
    pauseMeeting: vi.fn(ok),
    resumeMeeting: vi.fn(ok),
    stopMeeting: vi.fn(ok),
    keepMeeting: vi.fn(ok),
    discardMeeting: vi.fn(ok),
    onMeetingTranscript: (listener) => {
      transcriptListeners.add(listener);
      return () => transcriptListeners.delete(listener);
    },
  } satisfies NotepadApi;
  window.voice = api;
  return {
    api,
    push: (state: NotepadState | null) =>
      act(() => notepadListeners.forEach((listener) => listener(state))),
    hear: (entries: TranscriptEntry[]) =>
      act(() => transcriptListeners.forEach((listener) => listener({ id, entries }))),
  };
}

let root: Root | null = null;

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Notepad />));
}

const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (element) => (element.getAttribute("aria-label") ?? element.textContent) === name,
  );
const thoughts = () => document.querySelector<HTMLTextAreaElement>("textarea")!;

async function openThoughts() {
  await act(async () => button("My thoughts")?.click());
}

function type(text: string) {
  const area = thoughts();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(area, text);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("the notepad", () => {
  test("shows the live transcript as You and Others, following new lines", async () => {
    const { hear } = fakeNotepad({ meeting, prompt: null }, [said("a", "Morning all", "mic")]);
    await render();
    hear([said("b", "The export bug is fixed", "system")]);
    const lines = [...document.querySelectorAll("ol li")].map((li) => li.textContent);
    expect(lines).toEqual(["You00:00Morning all", "Others00:00The export bug is fixed"]);
  });

  test("offers Pause and Stop while recording, and says so", async () => {
    const { api } = fakeNotepad({ meeting, prompt: null });
    await render();
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Recording");
    await act(async () => button("Pause")?.click());
    expect(api.pauseMeeting).toHaveBeenCalledWith(id);
  });

  test("asks Started by mistake? and answers with Keep or Discard", async () => {
    const short = { ...meeting, status: { kind: "confirmingShort" } } satisfies Meeting;
    const { api } = fakeNotepad({ meeting: short, prompt: { kind: "startedByMistake" } });
    await render();
    expect(document.body.textContent).toContain("Started by mistake?");
    expect(document.body.textContent).not.toContain("Recording");
    await act(async () => button("Keep")?.click());
    expect(api.keepMeeting).toHaveBeenCalledWith(id);
    await act(async () => button("Discard")?.click());
    expect(api.discardMeeting).toHaveBeenCalledWith(id);
  });

  test("Keep recording answers the silence prompt without stopping", async () => {
    const { api } = fakeNotepad({ meeting, prompt: { kind: "silence" } });
    await render();
    await act(async () => button("Keep recording")?.click());
    expect(api.dismissMeetingPrompt).toHaveBeenCalled();
    expect(api.stopMeeting).not.toHaveBeenCalled();
  });
});

describe("My thoughts in the notepad", () => {
  test("saves typing after a pause", async () => {
    const { api } = fakeNotepad({ meeting, prompt: null });
    await render();
    await openThoughts();
    type("Ask about pricing");
    expect(api.updateMeetingNotes).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(600));
    expect(api.updateMeetingNotes).toHaveBeenCalledWith(id, "Ask about pricing");
  });

  test("shows thoughts written in the Voice window", async () => {
    const { push } = fakeNotepad({ meeting, prompt: null });
    await render();
    await openThoughts();
    push({ meeting: { ...meeting, notes: "Written in the hub" }, prompt: null });
    expect(thoughts().value).toBe("Written in the hub");
  });

  test("keeps what the user is typing over an older copy from main", async () => {
    const { push } = fakeNotepad({ meeting: { ...meeting, notes: "Old" }, prompt: null });
    await render();
    await openThoughts();
    type("Old and new");
    push({ meeting: { ...meeting, notes: "Old" }, prompt: null });
    expect(thoughts().value).toBe("Old and new");
    // Once main holds the typed text it follows main again.
    push({ meeting: { ...meeting, notes: "Old and new" }, prompt: null });
    push({ meeting: { ...meeting, notes: "Edited elsewhere" }, prompt: null });
    expect(thoughts().value).toBe("Edited elsewhere");
  });
});

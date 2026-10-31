// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { NotepadApi } from "../shared/api.ts";
import type {
  Meeting,
  MeetingId,
  MeetingPartial,
  MeetingSource,
  MeetingTranscriptChange,
  NotepadState,
  SpeakerId,
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
  speakers: [],
  finalPassFailed: false,
};

const said = (segmentId: string, text: string, source: "mic" | "system"): TranscriptEntry =>
  source === "mic"
    ? { kind: "segment", id: segmentId, startMs: 0, endMs: 1, text, source }
    : {
        kind: "segment",
        id: segmentId,
        startMs: 0,
        endMs: 1,
        text,
        source,
        speakerId: null,
      };

function fakeNotepad(first: NotepadState, transcript: TranscriptEntry[] = []) {
  const notepadListeners = new Set<(state: NotepadState | null) => void>();
  const transcriptListeners = new Set<(change: MeetingTranscriptChange) => void>();
  const partialListeners = new Set<(partial: MeetingPartial) => void>();
  const ok = async () => ({ kind: "ok", id }) as const;
  const api = {
    diagnosticsStartedAtLaunch: false,
    getNotepad: async () => first,
    onNotepad: (listener) => {
      notepadListeners.add(listener);
      return () => notepadListeners.delete(listener);
    },
    dismissMeetingPrompt: vi.fn(async () => {}),
    viewMeetingSummary: vi.fn(async () => {}),
    getMeeting: async () => ({ meeting: first.meeting, transcript: [...transcript] }),
    updateMeetingNotes: vi.fn(async (_id: MeetingId, _notes: string) => {}),
    pauseMeeting: vi.fn(ok),
    resumeMeeting: vi.fn(ok),
    stopMeeting: vi.fn(ok),
    keepMeeting: vi.fn(ok),
    discardMeeting: vi.fn(ok),
    onMeetingTranscript: (listener) => {
      transcriptListeners.add(listener);
      return () => transcriptListeners.delete(listener);
    },
    onMeetingPartial: (listener) => {
      partialListeners.add(listener);
      return () => partialListeners.delete(listener);
    },
  } satisfies NotepadApi;
  window.voice = api;
  return {
    api,
    push: (state: NotepadState | null) =>
      act(() => notepadListeners.forEach((listener) => listener(state))),
    hear: (entries: TranscriptEntry[]) =>
      act(() => transcriptListeners.forEach((listener) => listener({ id, entries }))),
    murmur: (source: MeetingSource, text: string) =>
      act(() => partialListeners.forEach((listener) => listener({ id, source, text }))),
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
const lines = () => [...document.querySelectorAll("ol li")].map((li) => li.textContent);
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
    expect(lines()).toEqual(["You00:00Morning all", "Others00:00The export bug is fixed"]);
  });

  test("before anyone speaks it reminds the user to get consent, and the reminder goes once they do", async () => {
    const { hear } = fakeNotepad({ meeting, prompt: null }, []);
    await render();
    expect(document.body.textContent).toContain("Always get consent before recording others.");
    hear([said("a", "Morning all", "mic")]);
    expect(document.body.textContent).not.toContain("Always get consent before recording others.");
  });

  test("shows each side's unconfirmed text in gray after the transcript until it stops", async () => {
    const { hear, murmur, push } = fakeNotepad({ meeting, prompt: null }, [
      said("a", "Morning all", "mic"),
    ]);
    await render();
    murmur("system", "The export bug");
    murmur("mic", "Great");
    expect(lines()).toEqual(["You00:00Morning all", "YouGreat", "OthersThe export bug"]);
    const gray = [...document.querySelectorAll("ol li p")].find((p) => p.textContent === "Great");
    const final = [...document.querySelectorAll("ol li p")].find(
      (p) => p.textContent === "Morning all",
    );
    expect(gray?.className).not.toBe(final?.className);

    hear([said("b", "The export bug is fixed", "system")]);
    murmur("system", "");
    expect(lines()).toEqual([
      "You00:00Morning all",
      "Others00:00The export bug is fixed",
      "YouGreat",
    ]);

    push({
      meeting: { ...meeting, status: { kind: "transcribing", step: "finalizing" } },
      prompt: null,
    });
    expect(lines()).toEqual(["You00:00Morning all", "Others00:00The export bug is fixed"]);
  });

  test("labels other voices by speaker once diarized, and follows a rename", async () => {
    const s1 = "s1" as SpeakerId;
    const done = {
      ...meeting,
      status: { kind: "ready" },
      speakers: [{ id: s1, label: "Speaker 1", name: null }],
    } satisfies Meeting;
    const { push } = fakeNotepad({ meeting: done, prompt: null }, [
      { ...said("a", "Ship it Friday", "system"), speakerId: s1 } as TranscriptEntry,
    ]);
    await render();
    expect(document.querySelector("ol li")?.textContent).toBe("Speaker 100:00Ship it Friday");
    push({
      meeting: {
        ...done,
        speakers: [{ id: s1, label: "Speaker 1", name: "Ann" }],
      },
      prompt: null,
    });
    expect(document.querySelector("ol li")?.textContent).toBe("Ann00:00Ship it Friday");
  });

  test("shows the final transcript with its speakers once the meeting is ready", async () => {
    const transcript = [said("a", "Ship it Fridy", "system")];
    const { push } = fakeNotepad({ meeting, prompt: null }, transcript);
    await render();
    expect(lines()).toEqual(["Others00:00Ship it Fridy"]);

    const s1 = "s1" as SpeakerId;
    transcript.splice(0, 1, {
      ...said("f", "Ship it Friday", "system"),
      speakerId: s1,
    } as TranscriptEntry);
    await act(async () =>
      push({
        meeting: {
          ...meeting,
          status: { kind: "ready" },
          speakers: [{ id: s1, label: "Speaker 1", name: null }],
        },
        prompt: null,
      }),
    );
    expect(lines()).toEqual(["Speaker 100:00Ship it Friday"]);
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

  test("saves what the delay has not sent when the window closes", async () => {
    const { api } = fakeNotepad({ meeting, prompt: null });
    await render();
    await openThoughts();
    type("Follow up with Tom on pricing");
    act(() => window.dispatchEvent(new Event("beforeunload")));
    expect(api.updateMeetingNotes).toHaveBeenCalledWith(id, "Follow up with Tom on pricing");
  });

  test("a failed save keeps the text and saves it again on Try again", async () => {
    const { api } = fakeNotepad({ meeting, prompt: null });
    api.updateMeetingNotes.mockRejectedValueOnce(new Error("disk full"));
    await render();
    await openThoughts();
    type("Ask about pricing");
    await act(async () => vi.advanceTimersByTime(600));
    expect(document.querySelector("[role=alert]")?.textContent).toBe("disk full");
    expect(thoughts().value).toBe("Ask about pricing");
    await act(async () => button("Try again")?.click());
    expect(api.updateMeetingNotes).toHaveBeenCalledTimes(2);
    expect(api.updateMeetingNotes).toHaveBeenLastCalledWith(id, "Ask about pricing");
    expect(document.querySelector("[role=alert]")).toBeNull();
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

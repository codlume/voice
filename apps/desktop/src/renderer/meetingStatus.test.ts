import { describe, expect, test } from "vite-plus/test";

import type { Meeting, MeetingId, MeetingStatus, TranscriptEntry } from "../shared/meetings.ts";
import { mergeTranscript } from "./meetingsView.ts";
import { clockTicks, promptView, statusClock, statusLabel, statusView } from "./meetingStatus.ts";

const meeting = (status: MeetingStatus): Meeting => ({
  id: "00000000-0000-4000-8000-000000000001" as MeetingId,
  title: null,
  createdAt: 0,
  spans: [{ startedAt: 0, endedAt: 30_000 }],
  status,
  folderIds: [],
  notes: "",
  summary: { kind: "none" },
  speakers: [],
  finalPassFailed: null,
  transcriptRevision: 0,
});

const commands = (view: ReturnType<typeof promptView>) =>
  view.actions.map(({ label, command }) => [label, command]);

const segment = (id: string, text: string): TranscriptEntry => ({
  kind: "segment",
  id,
  startMs: 0,
  endMs: 1000,
  text,
  source: "mic",
});

describe("statusView", () => {
  test("offers pause while recording and resume while paused, with Stop for both", () => {
    expect(statusView({ kind: "recording" })).toEqual({
      tone: "recording",
      label: "Recording",
      controls: ["pause", "stop"],
    });
    expect(statusView({ kind: "paused" })).toMatchObject({
      tone: "paused",
      controls: ["resume", "stop"],
    });
    expect(statusClock(meeting({ kind: "recording", since: 100_000 }), 110_000)).toBe("00:40");
    expect(statusClock(meeting({ kind: "paused" }), 110_000)).toBe("00:30");
  });

  test("says recording only while it records, and offers only Resume once saved", () => {
    for (const kind of ["finishing", "confirmingShort", "transcribing"] as const) {
      const status = statusView({ kind });
      expect(status.tone).not.toBe("recording");
      expect(status.controls).toEqual([]);
    }
    for (const kind of ["summarizing", "ready"] as const) {
      expect(statusView({ kind })).toMatchObject({ tone: "done", controls: ["resume"] });
    }
    expect(statusView({ kind: "starting" }).tone).toBe("busy");
  });

  test("a ready meeting needs no status word in lists, and the rest use the same words everywhere", () => {
    expect(statusLabel(meeting({ kind: "ready" }))).toBeNull();
    expect(statusLabel(meeting({ kind: "finishing" }))).toBe("Wrapping up…");
    expect(statusLabel(meeting({ kind: "summarizing", progress: null }))).toBe("Writing summary…");
  });

  test("the clock runs only while recording or counting down to the limit", () => {
    expect(clockTicks({ kind: "recording" }, null)).toBe(true);
    expect(clockTicks({ kind: "paused" }, null)).toBe(false);
    expect(clockTicks({ kind: "paused" }, { kind: "maxLengthSoon", endsAt: 1 })).toBe(true);
  });
});

describe("promptView", () => {
  test("Started by mistake? keeps or discards the meeting", () => {
    const view = promptView({ kind: "startedByMistake" }, 0);
    expect(view.title).toBe("Started by mistake?");
    expect(commands(view)).toEqual([
      ["Discard", "discard"],
      ["Keep", "keep"],
    ]);
  });

  test("Still in a meeting? keeps recording or stops", () => {
    const view = promptView({ kind: "silence" }, 0);
    expect(view.title).toBe("Still in a meeting?");
    expect(commands(view)).toEqual([
      ["Stop", "stop"],
      ["Keep recording", "dismiss"],
    ]);
  });

  test("the length warning counts down in whole minutes", () => {
    const view = promptView({ kind: "maxLengthSoon", endsAt: 5 * 60_000 }, 30_000);
    expect(view.body).toContain("stops in 5 min");
    expect(commands(view)).toEqual([
      ["End recording", "stop"],
      ["Dismiss", "dismiss"],
    ]);
  });
});

describe("mergeTranscript", () => {
  const marker: TranscriptEntry = { kind: "marker", marker: "dictated", atMs: 500 };

  test("live lines the read already holds are not added twice", () => {
    const read = [segment("a", "Hello"), marker];
    expect(mergeTranscript(read, [marker, segment("b", "there")])).toEqual([
      ...read,
      segment("b", "there"),
    ]);
  });
});

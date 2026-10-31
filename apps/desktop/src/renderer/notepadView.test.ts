import { describe, expect, test } from "vite-plus/test";

import type { Meeting, MeetingId, MeetingStatus, TranscriptEntry } from "../shared/meetings.ts";
import { mergeTranscript, notepadStatus, notepadTicks, promptView } from "./notepadView.ts";

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
  finalPassFailed: false,
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

describe("notepadStatus", () => {
  test("offers pause while recording and resume while paused, with Stop for both", () => {
    expect(notepadStatus(meeting({ kind: "recording", since: 100_000 }), 110_000)).toEqual({
      tone: "recording",
      label: "Recording",
      clock: "00:40",
      controls: ["pause", "stop"],
    });
    expect(notepadStatus(meeting({ kind: "paused" }), 110_000)).toMatchObject({
      tone: "paused",
      clock: "00:30",
      controls: ["resume", "stop"],
    });
  });

  test("says recording only while it records, and offers no controls after Stop", () => {
    const statuses: MeetingStatus[] = [
      { kind: "finishing" },
      { kind: "confirmingShort" },
      { kind: "transcribing", step: "finalizing" },
      { kind: "ready" },
    ];
    for (const done of statuses) {
      const status = notepadStatus(meeting(done), 0);
      expect(status.tone).not.toBe("recording");
      expect(status.controls).toEqual([]);
    }
    expect(notepadStatus(meeting({ kind: "starting", from: "new" }), 0).tone).toBe("busy");
  });

  test("the clock runs only while recording or counting down to the limit", () => {
    expect(notepadTicks(meeting({ kind: "recording", since: 0 }), null)).toBe(true);
    expect(notepadTicks(meeting({ kind: "paused" }), null)).toBe(false);
    expect(notepadTicks(meeting({ kind: "paused" }), { kind: "maxLengthSoon", endsAt: 1 })).toBe(
      true,
    );
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

import { describe, expect, test } from "vite-plus/test";

import type { Meeting, MeetingId, SpeakerId, TranscriptEntry } from "../shared/meetings.ts";
import { applyFinalPass } from "./meeting-final-pass.ts";

const meeting: Meeting = {
  id: "11111111-1111-4111-8111-111111111111" as MeetingId,
  title: null,
  createdAt: 0,
  spans: [],
  status: { kind: "transcribing", step: "finalizing" },
  folderIds: [],
  notes: "",
  summary: { kind: "none" },
  speakers: [],
  finalPassFailed: false,
};

let ids = 0;
const nextId = () => `f${++ids}`;

describe("applying the final pass", () => {
  test("running it again over the same audio gives the same speakers, not more", () => {
    const live: TranscriptEntry[] = [
      {
        kind: "segment",
        id: "l1",
        startMs: 0,
        endMs: 900,
        text: "helo",
        final: true,
        source: "mic",
      },
      { kind: "marker", marker: "dictated", atMs: 1000 },
    ];
    const pass = [
      { source: "system" as const, startMs: 100, endMs: 800, text: "Hi", speaker: 1 },
      { source: "system" as const, startMs: 0, endMs: 90, text: "So", speaker: 0 },
    ];
    const first = applyFinalPass(meeting, live, pass, 0, nextId);
    const again = applyFinalPass(first.meeting, first.transcript, pass, 0, nextId);
    expect(again.meeting.speakers.map(({ id }) => id)).toEqual(["s1", "s2"]);
    expect(again.transcript).toEqual([
      { kind: "marker", marker: "dictated", atMs: 1000 },
      expect.objectContaining({ text: "Hi", speakerId: "s2" as SpeakerId }),
      expect.objectContaining({ text: "So", speakerId: "s1" as SpeakerId }),
    ]);
  });
});

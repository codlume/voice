import { describe, expect, test } from "vite-plus/test";

import { meetingMarkdown } from "./meeting-markdown.ts";
import type { Meeting, MeetingId, SpeakerId, TranscriptEntry } from "./meetings.ts";

const START = Date.UTC(2026, 9, 31, 14, 5);

const meeting: Meeting = {
  id: "11111111-1111-4111-8111-111111111111" as MeetingId,
  title: "Launch plan",
  createdAt: START - 1000,
  spans: [{ startedAt: START, endedAt: START + 3_700_000 }],
  status: { kind: "ready" },
  folderIds: [],
  notes: "  Follow up with legal.  ",
  summary: {
    kind: "ready",
    summary: {
      markdown:
        "We agreed to ship on Friday.\n\n### Decisions\n- Ship Friday\n\n### Next Steps\n**{{speaker:s1}}**\n- Draft the post",
      coversUntilMs: 3_700_000,
    },
  },
  speakers: [{ id: "s1" as SpeakerId, label: "Speaker 1", name: "Ana" }],
  finalPassFailed: false,
};

const transcript: TranscriptEntry[] = [
  {
    kind: "segment",
    id: "b",
    source: "system",
    speakerId: "s1" as SpeakerId,
    startMs: 4000,
    endMs: 6000,
    text: "Friday works.",
  },
  {
    kind: "segment",
    id: "a",
    source: "mic",
    startMs: 0,
    endMs: 3000,
    text: "Can we ship Friday?",
  },
  {
    kind: "segment",
    id: "c",
    source: "system",
    speakerId: null,
    startMs: 3_661_000,
    endMs: 3_662_000,
    text: "Bye",
  },
  { kind: "segment", id: "e", source: "mic", startMs: 9000, endMs: 9000, text: "  " },
  { kind: "marker", marker: "paused", atMs: 10_000 },
];

describe("meeting markdown", () => {
  test("has the title, date, summary, My thoughts and the transcript in time order", () => {
    expect(meetingMarkdown(meeting, transcript, { locale: "en-US", timeZone: "UTC" })).toBe(
      [
        "# Launch plan",
        "",
        "October 31, 2026 at 2:05 PM",
        "",
        "## Summary",
        "",
        "We agreed to ship on Friday.",
        "",
        "### Decisions",
        "- Ship Friday",
        "",
        "### Next Steps",
        "**Ana**",
        "- Draft the post",
        "",
        "## My thoughts",
        "",
        "Follow up with legal.",
        "",
        "## Transcript",
        "",
        "**You** (00:00): Can we ship Friday?",
        "",
        "**Ana** (00:04): Friday works.",
        "",
        "*Paused at 00:10*",
        "",
        "**Others** (1:01:01): Bye",
        "",
      ].join("\n"),
    );
  });

  test("keeps the previous summary a failed update left, as the page shows it", () => {
    if (meeting.summary.kind !== "ready") throw new Error("the fixture has a summary");
    const failed: Meeting = {
      ...meeting,
      summary: { kind: "failed", message: "The model stopped.", previous: meeting.summary.summary },
    };
    expect(meetingMarkdown(failed, [], { locale: "en-US", timeZone: "UTC" })).toContain(
      "## Summary\n\n*Previous summary. Updating it failed.*\n\nWe agreed to ship on Friday.",
    );
  });

  test("leaves out the sections a meeting does not have yet", () => {
    const bare: Meeting = { ...meeting, title: null, notes: " ", summary: { kind: "none" } };
    expect(meetingMarkdown(bare, [], { locale: "en-US", timeZone: "UTC" })).toBe(
      "# Untitled meeting\n\nOctober 31, 2026 at 2:05 PM\n",
    );
  });
});

import { describe, expect, test } from "vite-plus/test";

import type { DayKey } from "../shared/insights.ts";
import type { Meeting, MeetingId, Speaker, SpeakerId } from "../shared/meetings.ts";
import {
  expiredBy,
  inlineRuns,
  meetingDays,
  overview,
  retentionSentence,
  searchResults,
  summaryBlocks,
  transcriptRows,
} from "./meetingsView.ts";

const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 0).getTime();

const named = (id: string, label: string, name: string | null): Speaker => ({
  id: id as SpeakerId,
  label,
  name: name === null ? null : name,
});

function meeting(id: string, startedAt: number, patch: Partial<Meeting> = {}): Meeting {
  return {
    id: id as MeetingId,
    title: id,
    createdAt: startedAt,
    spans: [{ startedAt, endedAt: startedAt + 30 * 60_000 }],
    status: { kind: "ready" },
    folderIds: [],
    notes: "",
    summary: { kind: "none" },
    speakers: [],
    finalPassFailed: false,
    ...patch,
  };
}

const today = "2026-10-22" as DayKey;

describe("meetingDays", () => {
  test("groups newest first by local day, with Today and Yesterday named", () => {
    const meetings = [
      meeting("standup", at(22, 9)),
      meeting("retro", at(21, 16)),
      meeting("planning", at(21, 10)),
      meeting("kickoff", at(14, 11)),
    ];
    const days = meetingDays(meetings, today, "en-US");
    expect(days.map(({ label }) => label)).toEqual(["Today", "Yesterday", "October 14, 2026"]);
    expect(days[1]!.meetings.map(({ id }) => id)).toEqual(["retro", "planning"]);
  });

  test("files a meeting that never recorded under the day it was made", () => {
    const empty = meeting("empty", at(20, 8), {
      spans: [],
      status: { kind: "starting", from: "new" },
    });
    expect(meetingDays([empty], today, "en-US")[0]!.label).toBe("October 20, 2026");
  });
});

describe("summary", () => {
  const markdown = [
    "Ania and Tomek agreed to ship the beta on Friday. Annual planning moves to November.",
    "",
    "### Decisions",
    "- Ship the **beta** on Friday",
    "",
    "### Next Steps",
    "- **Ania**",
    "  - Send the release notes",
    "  - Book the demo",
    "- **Tomek**",
    "  - Fix the export bug",
  ].join("\n");

  test("the overview is the first paragraph", () => {
    expect(overview(markdown)).toBe(
      "Ania and Tomek agreed to ship the beta on Friday. Annual planning moves to November.",
    );
    expect(overview("### Decisions\n- None")).toBeNull();
  });

  test("a summary with no overview paragraph has no overview, not its first owner", () => {
    expect(
      overview("### Decisions\n\n- Ship\n\n### Next Steps\n\n**{{speaker:s1}}**\n- Tell support\n"),
    ).toBeNull();
  });

  test("next steps keep their owners with the owner's tasks", () => {
    const blocks = summaryBlocks(markdown);
    expect(blocks.map((block) => block.kind)).toEqual([
      "paragraph",
      "heading",
      "list",
      "heading",
      "list",
    ]);
    expect(blocks[4]).toEqual({
      kind: "list",
      line: 6,
      items: [
        {
          line: 6,
          text: "**Ania**",
          children: [
            { line: 7, text: "Send the release notes" },
            { line: 8, text: "Book the demo" },
          ],
        },
        { line: 9, text: "**Tomek**", children: [{ line: 10, text: "Fix the export bug" }] },
      ],
    });
  });

  test("highlights speaker names as whole words and keeps bold", () => {
    const runs = inlineRuns("Ania met Ann about the **Annual** plan", [
      named("s1", "Speaker 1", "Ann"),
      named("s2", "Speaker 2", "Ania"),
    ]);
    expect(runs.filter((run) => run.name).map((run) => run.text)).toEqual(["Ania", "Ann"]);
    expect(runs.find((run) => run.text === "Annual")).toEqual({
      text: "Annual",
      bold: true,
      name: false,
      at: 25,
    });
    expect(runs.map((run) => run.text).join("")).toBe("Ania met Ann about the Annual plan");
  });

  test("a speaker token shows the speaker's current name, highlighted, inside bold too", () => {
    const speakers = [named("s1", "Speaker 1", "Ania"), named("s2", "Speaker 2", null)];
    const runs = inlineRuns(
      "{{speaker:s1}} asked **{{speaker:s2}}** and {{speaker:you}}",
      speakers,
    );
    expect(runs.map(({ text, bold, name }) => ({ text, bold, name }))).toEqual([
      { text: "Ania", bold: false, name: true },
      { text: " asked ", bold: false, name: false },
      { text: "Speaker 2", bold: true, name: true },
      { text: " and ", bold: false, name: false },
      { text: "You", bold: false, name: true },
    ]);
    expect(new Set(runs.map((run) => run.at)).size).toBe(runs.length);
  });
});

test("transcript rows name each voice once per turn and mark pauses and dictation", () => {
  const rows = transcriptRows(
    [
      { kind: "segment", id: "a", startMs: 0, endMs: 1, text: "Hello", source: "mic" },
      {
        kind: "segment",
        id: "b",
        startMs: 2000,
        endMs: 3000,
        text: "again",
        source: "mic",
      },
      { kind: "marker", marker: "dictated", atMs: 4000 },
      {
        kind: "segment",
        id: "c",
        startMs: 65_000,
        endMs: 66_000,
        text: "Hi",
        source: "system",
        speakerId: null,
      },
      { kind: "marker", marker: "paused", atMs: 70_000 },
    ],
    [],
  );
  expect(rows).toEqual([
    expect.objectContaining({ speaker: "You", mine: true, time: "00:00", continues: false }),
    expect.objectContaining({ speaker: "You", continues: true }),
    expect.objectContaining({ kind: "marker", text: "Dictated at 00:04" }),
    expect.objectContaining({ speaker: "Others", mine: false, continues: false }),
    expect.objectContaining({ kind: "marker", text: "Paused at 01:10" }),
  ]);
});

test("search results follow main's order, say where they matched, and skip deleted meetings", () => {
  const a = meeting("a", at(22, 9));
  const b = meeting("b", at(21, 9));
  const results = searchResults(
    [a, b],
    [
      {
        id: b.id,
        field: "transcript",
        snippet: { before: "…the ", match: "export", after: " bug…" },
      },
      {
        id: "gone" as MeetingId,
        field: "title",
        snippet: { before: "", match: "gone", after: "" },
      },
      { id: a.id, field: "title", snippet: { before: "", match: "a", after: "" } },
    ],
  );
  expect(results.map((result) => [result.meeting.id, result.where])).toEqual([
    ["b", "Transcript"],
    ["a", null],
  ]);
});

describe("retention", () => {
  test("states how long transcripts are kept", () => {
    expect(retentionSentence("month")).toMatch(
      /stay on this Mac for 30 days, then they are deleted/,
    );
    expect(retentionSentence("forever")).toMatch(/until you delete them/);
  });

  test("counts only finished meetings past the window", () => {
    const now = at(31, 12);
    const meetings = [
      meeting("old", at(1, 9)),
      meeting("recent", at(30, 9)),
      meeting("old but recording", at(1, 9), { status: { kind: "paused" } }),
    ];
    expect(expiredBy(meetings, "week", now)).toBe(1);
    expect(expiredBy(meetings, "forever", now)).toBe(0);
  });
});

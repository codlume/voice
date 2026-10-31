import { describe, expect, test } from "vite-plus/test";

import {
  applyMeetingsChange,
  DEFAULT_MEETINGS_SETTINGS,
  meetingToggle,
  meetingToggleLabels,
  parseFolderDraft,
  parseMeetingId,
  parseMeetingsSettingsPatch,
  addSpeakers,
  renameSpeaker,
  resolveSpeakerTokens,
  retitle,
  searchMeeting,
  speakerToken,
  type Folder,
  type FolderId,
  type Meeting,
  type MeetingId,
  type MeetingStatus,
  type MeetingsState,
  type SpeakerId,
  type TranscriptEntry,
} from "./meetings.ts";

const A = "11111111-1111-4111-8111-111111111111" as MeetingId;
const B = "22222222-2222-4222-8222-222222222222" as MeetingId;
const ONES = "33333333-3333-4333-8333-333333333333" as FolderId;
const MANUAL = "44444444-4444-4444-8444-444444444444" as FolderId;

const meeting = (id: MeetingId, createdAt: number, overrides: Partial<Meeting> = {}): Meeting => ({
  id,
  title: null,
  createdAt,
  spans: [],
  status: { kind: "ready" },
  folderIds: [],
  notes: "",
  summary: { kind: "none" },
  speakers: [],
  finalPassFailed: false,
  transcriptRevision: 0,
  ...overrides,
});

const folders: Folder[] = [
  {
    id: ONES,
    name: "1:1s",
    createdAt: 0,
    kind: "auto",
    rule: { kind: "titleContains", text: "1:1" },
  },
  { id: MANUAL, name: "Clients", createdAt: 0, kind: "manual" },
];

describe("meetings", () => {
  test("ids are UUIDs only, so none can name a path outside its folder", () => {
    expect(parseMeetingId(A)).toBe(A);
    expect(parseMeetingId("../settings")).toBeNull();
    expect(parseMeetingId(`${A}/..`)).toBeNull();
  });

  test("a patch upserts and removes meetings and keeps the list newest first", () => {
    const state: MeetingsState = {
      meetings: [meeting(B, 2), meeting(A, 1)],
      folders: [],
      settings: DEFAULT_MEETINGS_SETTINGS,
    };
    const renamed = meeting(A, 1, { notes: "new" });
    const next = applyMeetingsChange(state, {
      kind: "patch",
      upsert: [renamed],
      remove: [B],
      folders,
      settings: { ...DEFAULT_MEETINGS_SETTINGS, retention: "year" },
    });
    expect(next).toEqual({
      meetings: [renamed],
      folders,
      settings: { ...DEFAULT_MEETINGS_SETTINGS, retention: "year" },
    });
  });

  test("a title files the meeting into matching auto folders while they are on", () => {
    const titled = retitle(meeting(A, 1), "  Ana 1:1 ", folders, DEFAULT_MEETINGS_SETTINGS);
    expect(titled.title).toEqual("Ana 1:1");
    expect(titled.folderIds).toEqual([ONES]);

    const off = retitle(meeting(A, 1), "Ana 1:1", folders, {
      ...DEFAULT_MEETINGS_SETTINGS,
      autoFolders: false,
    });
    expect(off.folderIds).toEqual([]);

    expect(retitle(titled, "Ana 1:1 again", folders, DEFAULT_MEETINGS_SETTINGS).folderIds).toEqual([
      ONES,
    ]);
  });

  test("a blank title clears it so one can be generated", () => {
    const titled = meeting(A, 1, { title: "Old" });
    expect(retitle(titled, "   ", folders, DEFAULT_MEETINGS_SETTINGS).title).toBeNull();
  });

  test("settings patches keep only fields that parse", () => {
    expect(
      parseMeetingsSettingsPatch({
        maxLength: "4h",
        retention: "month",
        silencePrompt: false,
        autoFolders: "yes",
      }),
    ).toEqual({ retention: "month", silencePrompt: false });
    expect(parseMeetingsSettingsPatch(null)).toEqual({});
  });

  test("folder drafts need a name, and an auto folder needs its rule", () => {
    expect(parseFolderDraft({ name: "Clients", kind: "manual" })).toEqual({
      name: "Clients",
      kind: "manual",
    });
    expect(parseFolderDraft({ name: " ", kind: "manual" })).toBeNull();
    expect(parseFolderDraft({ name: "Series", kind: "auto" })).toBeNull();
    expect(
      parseFolderDraft({
        name: "Series",
        kind: "auto",
        rule: { kind: "calendarSeries", text: "x" },
      }),
    ).toBeNull();
  });

  test("speakers number on from the meeting's own, and a rename shows in every token", () => {
    const first = addSpeakers(meeting(A, 0), 2);
    expect(first.ids).toEqual(["s1", "s2"]);
    const more = addSpeakers(first.meeting, 1);
    expect(more.meeting.speakers.map(({ label }) => label)).toEqual([
      "Speaker 1",
      "Speaker 2",
      "Speaker 3",
    ]);
    const s2 = "s2" as SpeakerId;
    const markdown = `${speakerToken(s2)} owns it, with ${speakerToken("you")} and {{speaker:s9}}.`;
    expect(resolveSpeakerTokens(markdown, more.meeting.speakers)).toBe(
      "Speaker 2 owns it, with You and Others.",
    );
    const renamed = renameSpeaker(more.meeting, s2, " Tom ");
    expect(resolveSpeakerTokens(markdown, renamed.speakers)).toBe(
      "Tom owns it, with You and Others.",
    );
    expect(renameSpeaker(renamed, s2, "  ").speakers[1]?.name).toBeNull();
    expect(renameSpeaker(renamed, "s7" as SpeakerId, "Ann")).toBe(renamed);
  });
});

describe("meetingToggle", () => {
  const toggleWith = (status: MeetingStatus) => {
    const next = meetingToggle([meeting(A, 2), meeting(B, 1, { status })]);
    return { ...next, label: meetingToggleLabels[next.kind] };
  };

  test.each<[MeetingStatus, object]>([
    [
      { kind: "recording", since: 0 },
      { kind: "stop", id: B, label: "Stop meeting" },
    ],
    [{ kind: "paused" }, { kind: "stop", id: B, label: "Stop meeting" }],
    [
      { kind: "starting", from: "new" },
      { kind: "wait", id: B, label: "Starting meeting…" },
    ],
    [
      { kind: "starting", from: "paused" },
      { kind: "wait", id: B, label: "Starting meeting…" },
    ],
  ])("a meeting %j makes the shortcut and the menu bar item %j", (status, expected) => {
    expect(toggleWith(status)).toEqual(expected);
  });

  test.each<MeetingStatus>([
    { kind: "finishing" },
    { kind: "confirmingShort" },
    { kind: "transcribing", step: "finalizing" },
    { kind: "summarizing", progress: null },
    { kind: "ready" },
  ])("a meeting no longer recording, %j, leaves them starting a new one", (status) => {
    expect(toggleWith(status)).toEqual({ kind: "start", label: "Start meeting" });
    expect(meetingToggle([])).toEqual({ kind: "start" });
  });
});

describe("searchMeeting", () => {
  const said = (text: string, speakerId: SpeakerId | null): TranscriptEntry => ({
    kind: "segment",
    id: text,
    startMs: 0,
    endMs: 1,
    text,
    source: "system",
    speakerId,
  });
  const ola = "s1" as SpeakerId;
  const met = meeting(A, 1, {
    title: "Wyjazd do Łodzi",
    speakers: [{ id: ola, label: "Speaker 1", name: "Ola Żółć" }],
    summary: {
      kind: "ready",
      summary: {
        markdown: "### Decisions\n- **{{speaker:s1}}** books the train",
        coversUntilMs: 1,
      },
    },
  });

  test("finds words typed without their accents and marks what matched", () => {
    expect(searchMeeting(met, [], "lodzi")).toEqual({
      id: A,
      field: "title",
      snippet: { before: "Wyjazd do ", match: "Łodzi", after: "" },
    });
    expect(searchMeeting(met, [], "ŁÓDŹ")?.snippet.match).toBe("Łodz");
  });

  test("searches the summary as it reads, with names and without Markdown", () => {
    expect(searchMeeting(met, [], "zolc books")).toEqual({
      id: A,
      field: "summary",
      snippet: { before: "Decisions Ola ", match: "Żółć books", after: " the train" },
    });
    expect(searchMeeting(met, [], "###")).toBeNull();
  });

  test("finds a renamed speaker in the transcript", () => {
    const quiet = { ...met, summary: { kind: "none" } } as const;
    expect(searchMeeting(quiet, [said("I can do Friday", ola)], "ola zolc")).toMatchObject({
      field: "transcript",
      snippet: { match: "Ola Żółć", after: ": I can do Friday" },
    });
    expect(searchMeeting(quiet, [said("I can do Friday", null)], "others: i can")).toMatchObject({
      field: "transcript",
    });
  });
});

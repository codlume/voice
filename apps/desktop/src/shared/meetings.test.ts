import { describe, expect, test } from "vite-plus/test";

import {
  applyMeetingsChange,
  DEFAULT_MEETINGS_SETTINGS,
  parseFolderDraft,
  parseMeetingId,
  parseMeetingsSettingsPatch,
  retitle,
  type Folder,
  type FolderId,
  type Meeting,
  type MeetingId,
  type MeetingsState,
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
    expect(titled.title).toEqual({ text: "Ana 1:1", source: "user" });
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
    const titled = meeting(A, 1, { title: { text: "Old", source: "user" } });
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
});

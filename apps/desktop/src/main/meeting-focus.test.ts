import { describe, expect, test } from "vite-plus/test";

import type { Meeting, MeetingId, MeetingStatus } from "../shared/meetings.ts";
import {
  currentMeeting,
  dismiss,
  follow,
  noMeetingFocus,
  promptFor,
  raise,
  toPillMeeting,
} from "./meeting-focus.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as MeetingId;

function meeting(n: number, status: MeetingStatus, patch: Partial<Meeting> = {}): Meeting {
  return {
    id: id(n),
    title: null,
    createdAt: 1000 - n,
    spans: [],
    status,
    folderIds: [],
    notes: "",
    summary: { kind: "none" },
    ...patch,
  };
}

const recording = (n: number) => meeting(n, { kind: "recording", since: 5000 });

describe("currentMeeting", () => {
  test("a recording beats one waiting on the user, which beats a paused one", () => {
    const paused = meeting(1, { kind: "paused" });
    const short = meeting(2, { kind: "confirmingShort" });
    const live = recording(3);
    expect(currentMeeting([paused, short, live])?.id).toBe(live.id);
    expect(currentMeeting([paused, short])?.id).toBe(short.id);
    expect(currentMeeting([paused])?.id).toBe(paused.id);
  });

  test("finished meetings are never current", () => {
    const done = [
      meeting(1, { kind: "ready" }),
      meeting(2, { kind: "transcribing" }),
      meeting(3, { kind: "summarizing" }),
    ];
    expect(currentMeeting(done)).toBeNull();
  });
});

describe("prompts", () => {
  test("silence asks while recording and drops once the meeting stops recording", () => {
    const live = recording(1);
    let focus = follow(noMeetingFocus, [live]);
    focus = raise(focus, live.id, { kind: "silence" }, 0);
    expect(promptFor(live, focus)).toEqual({ kind: "silence" });

    const paused = meeting(1, { kind: "paused" });
    focus = follow(focus, [paused]);
    expect(promptFor(paused, focus)).toBeNull();
    // Resuming later does not bring back a question about the earlier leg.
    expect(promptFor(live, follow(focus, [live]))).toBeNull();
  });

  test("the length warning carries when the recording will stop", () => {
    const live = recording(1);
    const focus = raise(
      follow(noMeetingFocus, [live]),
      live.id,
      { kind: "maxLengthSoon", inMs: 300_000 },
      10_000,
    );
    expect(promptFor(live, focus)).toEqual({ kind: "maxLengthSoon", endsAt: 310_000 });
  });

  test("a lost capture leaves a notice on the paused meeting until resumed or dismissed", () => {
    const paused = meeting(1, { kind: "paused" });
    const focus = raise(follow(noMeetingFocus, [paused]), paused.id, { kind: "captureLost" }, 0);
    expect(promptFor(paused, focus)).toMatchObject({ kind: "notice" });
    expect(promptFor(paused, dismiss(focus))).toBeNull();
    expect(promptFor(recording(1), follow(focus, [recording(1)]))).toBeNull();
  });

  test("summary outcomes stay in the Voice window", () => {
    const live = recording(1);
    const focus = follow(noMeetingFocus, [live]);
    expect(raise(focus, live.id, { kind: "summaryReady", open: true }, 0)).toBe(focus);
  });

  test("a short recording asks Started by mistake, over anything a notice raised", () => {
    const short = meeting(1, { kind: "confirmingShort" });
    const focus = raise(follow(noMeetingFocus, [short]), short.id, { kind: "maxLengthReached" }, 0);
    expect(promptFor(short, focus)).toEqual({ kind: "startedByMistake" });
  });

  test("a prompt about another meeting is not shown on this one", () => {
    const live = recording(1);
    const other = meeting(2, { kind: "paused" });
    const focus = raise(
      follow(noMeetingFocus, [live, other]),
      other.id,
      { kind: "captureLost" },
      0,
    );
    expect(promptFor(live, focus)).toBeNull();
  });
});

describe("toPillMeeting", () => {
  test("no meeting, nothing on the Flow Bar", () => {
    expect(toPillMeeting(noMeetingFocus)).toBeNull();
    expect(toPillMeeting(follow(noMeetingFocus, [meeting(1, { kind: "ready" })]))).toBeNull();
  });

  test("counts closed legs and leaves the open one to the clock", () => {
    const live = recording(1);
    const resumed = {
      ...live,
      spans: [
        { startedAt: 0, endedAt: 60_000 },
        { startedAt: 100_000, endedAt: 130_000 },
      ],
    };
    expect(toPillMeeting(follow(noMeetingFocus, [resumed]))).toEqual({
      status: { kind: "recording", since: 5000 },
      closedMs: 90_000,
      prompt: null,
    });
  });

  test("notes typed during the meeting do not change what the Flow Bar shows", () => {
    const live = recording(1);
    const before = toPillMeeting(follow(noMeetingFocus, [live]));
    const after = toPillMeeting(follow(noMeetingFocus, [{ ...live, notes: "Ask about pricing" }]));
    expect(after).toEqual(before);
  });
});

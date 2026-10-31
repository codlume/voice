import { describe, expect, test } from "vite-plus/test";

import type { AudioLoss, Meeting, MeetingId, MeetingStatus } from "../shared/meetings.ts";
import {
  currentMeeting,
  dismiss,
  dismissBanner,
  follow,
  meetingBanners,
  noMeetingFocus,
  noticePrompt,
  promptFor,
  raise,
  toPillMeeting,
  type MeetingFocus,
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
    speakers: [],
    finalPassFailed: false,
    ...patch,
  };
}

const recording = (n: number) => meeting(n, { kind: "recording", since: 5000 });

const lostText = (loss: AudioLoss | null) => {
  const prompt = noticePrompt({ kind: "captureLost", loss }, 0);
  return prompt?.kind === "notice" ? prompt.text : null;
};

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
      meeting(2, { kind: "transcribing", step: "finalizing" }),
      meeting(3, { kind: "summarizing", progress: null }),
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
    const lost = { kind: "captureLost", loss: null } as const;
    const focus = raise(follow(noMeetingFocus, [paused]), paused.id, lost, 0);
    expect(promptFor(paused, focus)).toMatchObject({ kind: "notice" });
    expect(promptFor(paused, dismiss(focus))).toBeNull();
    expect(promptFor(recording(1), follow(focus, [recording(1)]))).toBeNull();
  });

  test("a lost capture says which source stopped and why", () => {
    expect(lostText({ source: "mic", reason: "device" })).toMatch(/^The microphone stopped, /);
    expect(lostText({ source: "system", reason: "permission" })).toMatch(
      /^Voice is no longer allowed to record system audio, /,
    );
    expect(lostText(null)).toMatch(/^Audio stopped coming in, /);
  });

  test("a ready summary is offered in the notepad and on the Meetings page until it is viewed or dismissed", () => {
    const done = meeting(
      1,
      { kind: "ready" },
      {
        summary: { kind: "ready", summary: { markdown: "Shipped.", coversUntilMs: 1000 } },
      },
    );
    const focus = raise(
      follow(noMeetingFocus, [done]),
      done.id,
      { kind: "summaryReady", open: true },
      0,
    );
    expect(promptFor(done, focus)).toEqual({ kind: "summaryReady" });
    expect(meetingBanners(focus)).toEqual([
      {
        key: 1,
        id: done.id,
        text: "Your summary is ready.",
        actions: ["viewSummary"],
        dismissable: true,
      },
    ]);
    expect(meetingBanners(dismiss(focus))).toEqual([]);
    // Recording again makes it moot.
    const resumed = follow(focus, [{ ...done, status: { kind: "recording", since: 0 } }]);
    expect(meetingBanners(resumed)).toEqual([]);
    expect(resumed.raised).toBeNull();
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
      { kind: "captureLost", loss: null },
      0,
    );
    expect(promptFor(live, focus)).toBeNull();
  });
});

const texts = (focus: MeetingFocus) => meetingBanners(focus).map(({ text }) => text);

describe("notices on the Meetings page", () => {
  test("outcomes show in the words the notepad uses; questions do not", () => {
    const paused = meeting(1, { kind: "paused" });
    let focus = follow(noMeetingFocus, [paused]);
    for (const notice of [
      { kind: "captureLost", loss: { source: "mic", reason: "device" } },
      { kind: "maxLengthReached" },
      { kind: "silence" },
      { kind: "maxLengthSoon", inMs: 1000 },
    ] as const) {
      focus = raise(focus, paused.id, notice, 0);
    }
    expect(texts(focus)).toEqual([
      "Recording stopped at the maximum length.",
      lostText({ source: "mic", reason: "device" }),
    ]);
    expect(meetingBanners(focus)[1]).toEqual({
      key: 1,
      id: paused.id,
      text: lostText({ source: "mic", reason: "device" }),
      actions: [],
      dismissable: true,
    });
  });

  test("dismissing in the notepad or on the page dismisses the notice in both", () => {
    const paused = meeting(1, { kind: "paused" });
    const lost = { kind: "captureLost", loss: null } as const;
    const focus = raise(follow(noMeetingFocus, [paused]), paused.id, lost, 0);
    expect(texts(focus)).toHaveLength(1);
    expect(texts(dismiss(focus))).toEqual([]);
    const [banner] = meetingBanners(focus);
    const fromPage = dismissBanner(focus, banner!.key);
    expect(texts(fromPage)).toEqual([]);
    expect(promptFor(paused, fromPage)).toBeNull();
  });

  test("a notice goes once it no longer applies", () => {
    const paused = meeting(1, { kind: "paused" });
    const lost = raise(
      follow(noMeetingFocus, [paused]),
      paused.id,
      { kind: "captureLost", loss: null },
      0,
    );
    expect(texts(follow(lost, [recording(1)]))).toEqual([]);
    expect(texts(follow(lost, []))).toEqual([]);

    const failed = meeting(
      2,
      { kind: "ready" },
      {
        summary: { kind: "failed", message: "No model", previous: null },
      },
    );
    const summary = raise(
      follow(noMeetingFocus, [failed]),
      failed.id,
      { kind: "summaryFailed", message: "No model" },
      0,
    );
    expect(texts(summary)).toEqual(["The summary could not be written. No model"]);
    expect(
      texts(follow(summary, [{ ...failed, status: { kind: "summarizing", progress: null } }])),
    ).toEqual([]);

    const done = meeting(3, { kind: "ready" }, { finalPassFailed: true });
    const pass = raise(follow(noMeetingFocus, [done]), done.id, { kind: "finalPassFailed" }, 0);
    expect(meetingBanners(pass)[0]).toMatchObject({
      actions: ["retryFinalPass", "deleteAudio"],
      dismissable: false,
    });
    expect(texts(follow(pass, [done]))).toHaveLength(1);
    expect(texts(follow(pass, [{ ...done, finalPassFailed: false }]))).toEqual([]);
    expect(texts(follow(pass, []))).toEqual([]);
  });

  test("a failed start has no meeting; it stays until one records", () => {
    const start = { kind: "startFailed", message: "Recording did not start." } as const;
    const focus = raise(noMeetingFocus, id(1), start, 0);
    expect(texts(follow(focus, []))).toEqual(["Recording did not start."]);
    expect(texts(follow(focus, [recording(2)]))).toEqual([]);
  });

  test("the same notice again replaces the earlier one", () => {
    const paused = meeting(1, { kind: "paused" });
    const lost = { kind: "captureLost", loss: null } as const;
    const twice = raise(
      raise(follow(noMeetingFocus, [paused]), paused.id, lost, 0),
      paused.id,
      lost,
      1,
    );
    expect(meetingBanners(twice).map(({ key }) => key)).toEqual([2]);
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

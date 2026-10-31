import { describe, expect, test } from "vite-plus/test";

import {
  DEFAULT_MEETINGS_SETTINGS,
  summaryStale,
  type Meeting,
  type MeetingId,
  type MeetingStatus,
} from "../shared/meetings.ts";
import {
  AUTO_SUMMARY_MIN_MS,
  MAX_LENGTH_WARNING_MS,
  step,
  type LifecycleConfig,
  type MeetingEffect,
  type MeetingEvent,
} from "./meeting-lifecycle.ts";

const ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b" as MeetingId;
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 31, 9, 0);
const config: LifecycleConfig = DEFAULT_MEETINGS_SETTINGS;

/** Folds `[event, ms after T0]` pairs from no meeting, keeping every effect. */
function play(events: [MeetingEvent, number][], options: { config?: LifecycleConfig } = {}) {
  let meeting: Meeting | null = null;
  const effects: MeetingEffect[] = [];
  for (const [event, at] of events) {
    const next = step(meeting, event, T0 + at, options.config ?? config);
    meeting = next.meeting;
    effects.push(...next.effects);
  }
  return { meeting, effects };
}

const recording = (minutes: number): [MeetingEvent, number][] => [
  [{ type: "start", id: ID }, 0],
  [{ type: "captureStarted", leg: 0 }, 0],
  [{ type: "stop" }, minutes * MIN],
];

const kinds = (effects: MeetingEffect[]) => effects.map((effect) => effect.type);
const notices = (effects: MeetingEffect[]) =>
  effects.flatMap((effect) => (effect.type === "notify" ? [effect.notice.kind] : []));

function meetingAt(status: MeetingStatus, overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: ID,
    title: null,
    createdAt: T0,
    spans: [{ startedAt: T0, endedAt: T0 + 20 * MIN }],
    status,
    folderIds: [],
    notes: "",
    summary: { kind: "none" },
    speakers: [],
    ...overrides,
  };
}

describe("meeting lifecycle", () => {
  test("a start asks for capture and records only once capture started", () => {
    const started = step(null, { type: "start", id: ID }, T0, config);
    expect(started.meeting?.status).toEqual({ kind: "starting", from: "new" });
    expect(started.effects).toEqual([{ type: "startCapture", leg: 0 }]);

    const live = step(started.meeting, { type: "captureStarted", leg: 0 }, T0 + 500, config);
    expect(live.meeting?.status).toEqual({ kind: "recording", since: T0 + 500 });
    expect(live.effects).toEqual([
      {
        type: "schedule",
        leg: 0,
        timer: "maxLengthWarning",
        inMs: 120 * MIN - MAX_LENGTH_WARNING_MS,
      },
      { type: "schedule", leg: 0, timer: "maxLength", inMs: 120 * MIN },
    ]);
  });

  test("a new meeting whose capture fails to start is deleted and the user told", () => {
    const { meeting, effects } = play([
      [{ type: "start", id: ID }, 0],
      [{ type: "captureFailed", leg: 0, message: "Microphone unavailable" }, 100],
    ]);
    expect(meeting).toBeNull();
    expect(effects).toContainEqual({ type: "delete" });
    expect(effects).toContainEqual({
      type: "notify",
      notice: { kind: "startFailed", message: "Microphone unavailable" },
    });
  });

  test("stopping or discarding while starting a new meeting cancels capture and keeps nothing", () => {
    for (const type of ["stop", "discard"] as const) {
      const { meeting, effects } = play([
        [{ type: "start", id: ID }, 0],
        [{ type }, 100],
      ]);
      expect(meeting).toBeNull();
      expect(kinds(effects)).toEqual(["startCapture", "stopCapture", "delete"]);
    }
  });

  test("pause closes the leg and resume appends a new one to the same meeting", () => {
    const { meeting, effects } = play([
      [{ type: "start", id: ID }, 0],
      [{ type: "captureStarted", leg: 0 }, 0],
      [{ type: "pause" }, 10 * MIN],
      [{ type: "resume" }, 15 * MIN],
      [{ type: "captureStarted", leg: 1 }, 15 * MIN],
      [{ type: "stop" }, 20 * MIN],
    ]);
    expect(meeting?.id).toBe(ID);
    expect(meeting?.spans).toEqual([
      { startedAt: T0, endedAt: T0 + 10 * MIN },
      { startedAt: T0 + 15 * MIN, endedAt: T0 + 20 * MIN },
    ]);
    expect(meeting?.status).toEqual({ kind: "finishing" });
    const marks = effects.flatMap((effect) => (effect.type === "mark" ? [effect.marker] : []));
    expect(marks).toEqual(["paused", "resumed"]);
    expect(effects).toContainEqual({ type: "startCapture", leg: 1 });
  });

  test("events from an earlier leg change nothing", () => {
    const { meeting } = play([
      [{ type: "start", id: ID }, 0],
      [{ type: "captureStarted", leg: 0 }, 0],
      [{ type: "pause" }, MIN],
      [{ type: "resume" }, 2 * MIN],
      [{ type: "captureStarted", leg: 1 }, 2 * MIN],
      [{ type: "timer", leg: 0, timer: "maxLength" }, 3 * MIN],
      [{ type: "captureLost", leg: 0, loss: { source: "mic", reason: "device" } }, 3 * MIN],
    ]);
    expect(meeting?.status).toEqual({ kind: "recording", since: T0 + 2 * MIN });
  });

  test("a failed resume returns to where the meeting was and keeps it", () => {
    for (const from of ["paused", "ready"] as const) {
      const resumed = step(meetingAt({ kind: from }), { type: "resume" }, T0 + 30 * MIN, config);
      expect(resumed.meeting?.status).toEqual({ kind: "starting", from });
      const failed = step(
        resumed.meeting,
        { type: "captureFailed", leg: 1, message: "busy" },
        T0 + 30 * MIN,
        config,
      );
      expect(failed.meeting?.status).toEqual({ kind: from });
      expect(notices(failed.effects)).toEqual(["resumeFailed"]);
    }
  });

  test("lost capture pauses with a gap marker instead of recording again on its own", () => {
    const { meeting, effects } = play([
      [{ type: "start", id: ID }, 0],
      [{ type: "captureStarted", leg: 0 }, 0],
      [{ type: "captureLost", leg: 0, loss: { source: "system", reason: "permission" } }, 7 * MIN],
    ]);
    expect(meeting?.status).toEqual({ kind: "paused" });
    expect(effects).toContainEqual({ type: "mark", marker: "gap" });
    expect(notices(effects)).toEqual(["captureLost"]);
    expect(effects).toContainEqual({
      type: "notify",
      notice: { kind: "captureLost", loss: { source: "system", reason: "permission" } },
    });
    expect(kinds(effects).filter((kind) => kind === "startCapture")).toHaveLength(1);
  });

  test("the max length warns, then ends the recording and finishes the meeting", () => {
    const short: LifecycleConfig = { ...config, maxLength: "30m" };
    const { meeting, effects } = play(
      [
        [{ type: "start", id: ID }, 0],
        [{ type: "captureStarted", leg: 0 }, 0],
        [{ type: "timer", leg: 0, timer: "maxLengthWarning" }, 25 * MIN],
        [{ type: "timer", leg: 0, timer: "maxLength" }, 30 * MIN],
      ],
      { config: short },
    );
    expect(effects).toContainEqual({
      type: "notify",
      notice: { kind: "maxLengthSoon", inMs: 5 * MIN },
    });
    expect(notices(effects)).toContain("maxLengthReached");
    expect(effects).toContainEqual({ type: "stopCapture", leg: 0 });
    expect(meeting?.status).toEqual({ kind: "finishing" });
    expect(meeting?.spans).toEqual([{ startedAt: T0, endedAt: T0 + 30 * MIN }]);
  });

  test("a resume schedules the limit from what is left, and a meeting at its limit refuses one", () => {
    const halfway = meetingAt(
      { kind: "paused" },
      { spans: [{ startedAt: T0, endedAt: T0 + 60 * MIN }] },
    );
    const resumed = step(halfway, { type: "resume" }, T0 + 70 * MIN, config);
    const live = step(resumed.meeting, { type: "captureStarted", leg: 1 }, T0 + 70 * MIN, config);
    expect(live.effects).toContainEqual({
      type: "schedule",
      leg: 1,
      timer: "maxLength",
      inMs: 60 * MIN,
    });

    const full = meetingAt(
      { kind: "ready" },
      { spans: [{ startedAt: T0, endedAt: T0 + 120 * MIN }] },
    );
    const refused = step(full, { type: "resume" }, T0 + 130 * MIN, config);
    expect(refused.meeting).toBe(full);
    expect(notices(refused.effects)).toEqual(["atMaxLength"]);
  });

  test("ten minutes of silence prompts only when the setting is on", () => {
    const events: [MeetingEvent, number][] = [
      [{ type: "start", id: ID }, 0],
      [{ type: "captureStarted", leg: 0 }, 0],
      [{ type: "silence", leg: 0 }, 10 * MIN],
    ];
    expect(notices(play(events).effects)).toEqual(["silence"]);
    expect(notices(play(events, { config: { ...config, silencePrompt: false } }).effects)).toEqual(
      [],
    );
    expect(play(events).meeting?.status.kind).toBe("recording");
  });

  test("a recording with only a few words asks before it is kept or discarded", () => {
    const short = play([...recording(1), [{ type: "drained", words: 3 }, MIN]]);
    expect(short.meeting?.status).toEqual({ kind: "confirmingShort" });

    const kept = step(short.meeting, { type: "keep" }, T0 + 2 * MIN, config);
    expect(kept.meeting?.status).toEqual({ kind: "transcribing" });
    expect(kept.effects).toEqual([{ type: "transcribeFinal" }]);

    const discarded = step(short.meeting, { type: "discard" }, T0 + 2 * MIN, config);
    expect(discarded.meeting).toBeNull();
    expect(discarded.effects).toEqual([{ type: "delete" }]);
  });

  test("a long meeting is summarized after the final pass, and a short one waits for the user", () => {
    const long = play([
      ...recording(30),
      [{ type: "drained", words: 4000 }, 30 * MIN],
      [{ type: "transcribed" }, 31 * MIN],
    ]);
    expect(long.meeting?.status).toEqual({ kind: "summarizing" });
    expect(kinds(long.effects)).toContain("summarize");

    const minutes = AUTO_SUMMARY_MIN_MS / MIN;
    const quick = play([
      ...recording(minutes),
      [{ type: "drained", words: 400 }, minutes * MIN],
      [{ type: "transcribed" }, minutes * MIN],
    ]);
    expect(quick.meeting?.status).toEqual({ kind: "ready" });
    expect(kinds(quick.effects)).not.toContain("summarize");

    const generating = step(quick.meeting, { type: "generateSummary" }, T0 + 6 * MIN, config);
    expect(generating.meeting?.status).toEqual({ kind: "summarizing" });
    expect(generating.effects).toEqual([{ type: "summarize" }]);
  });

  test("a failed final pass keeps the live transcript and still reaches ready", () => {
    const { meeting, effects } = play([
      ...recording(30),
      [{ type: "drained", words: 4000 }, 30 * MIN],
      [{ type: "transcribeFailed" }, 31 * MIN],
      [{ type: "summarized" }, 32 * MIN],
    ]);
    expect(notices(effects)).toEqual(["finalPassFailed", "summaryReady"]);
    expect(meeting?.status).toEqual({ kind: "ready" });
  });

  test("a finished summary opens when the setting says so and leaves the summary to meeting-summary", () => {
    const summarizing = meetingAt({ kind: "summarizing" });
    const done = step(summarizing, { type: "summarized" }, T0 + 25 * MIN, {
      ...config,
      openSummaryWhenReady: false,
    });
    expect(done.meeting).toEqual({ ...summarizing, status: { kind: "ready" } });
    expect(done.effects).toEqual([
      { type: "notify", notice: { kind: "summaryReady", open: false } },
    ]);
  });

  test("a failed summary still reaches ready", () => {
    const summarizing = meetingAt({ kind: "summarizing" });
    const failed = step(summarizing, { type: "summaryFailed" }, T0 + 25 * MIN, config);
    expect(failed.meeting).toEqual({ ...summarizing, status: { kind: "ready" } });
    expect(notices(failed.effects)).toEqual(["summaryFailed"]);
  });

  test("resuming a summarized meeting appends, leaves the summary stale and does not regenerate it", () => {
    const summary = {
      markdown: "Overview.",
      overview: "Overview.",
      generatedAt: T0,
      coversUntilMs: 20 * MIN,
    };
    let meeting: Meeting | null = meetingAt(
      { kind: "ready" },
      { summary: { kind: "ready", summary } },
    );
    expect(summaryStale(meeting)).toBe(false);
    const effects: MeetingEffect[] = [];
    const events: [MeetingEvent, number][] = [
      [{ type: "resume" }, 40 * MIN],
      [{ type: "captureStarted", leg: 1 }, 40 * MIN],
      [{ type: "stop" }, 50 * MIN],
      [{ type: "drained", words: 5000 }, 50 * MIN],
      [{ type: "transcribed" }, 51 * MIN],
    ];
    for (const [event, ms] of events) {
      const next = step(meeting, event, T0 + ms, config);
      meeting = next.meeting;
      effects.push(...next.effects);
    }
    expect(meeting?.status).toEqual({ kind: "ready" });
    expect(meeting?.spans).toHaveLength(2);
    expect(kinds(effects)).not.toContain("summarize");
    expect(summaryStale(meeting!)).toBe(true);
  });

  test("a discard from a live meeting stops capture and deletes it", () => {
    for (const status of [
      { kind: "recording", since: T0 + 20 * MIN },
      { kind: "paused" },
      { kind: "finishing" },
    ] satisfies MeetingStatus[]) {
      const { meeting, effects } = step(
        meetingAt(status),
        { type: "discard" },
        T0 + 25 * MIN,
        config,
      );
      expect(meeting).toBeNull();
      expect(effects.at(-1)).toEqual({ type: "delete" });
      expect(kinds(effects).includes("stopCapture")).toBe(status.kind === "recording");
    }
  });

  test("every status has a way out", () => {
    const exits: [MeetingStatus, MeetingEvent][] = [
      [
        { kind: "starting", from: "new" },
        { type: "captureFailed", leg: 1, message: "x" },
      ],
      [{ kind: "starting", from: "paused" }, { type: "stop" }],
      [{ kind: "starting", from: "ready" }, { type: "stop" }],
      [{ kind: "recording", since: T0 + 20 * MIN }, { type: "stop" }],
      [{ kind: "paused" }, { type: "stop" }],
      [{ kind: "finishing" }, { type: "drained", words: 100 }],
      [{ kind: "confirmingShort" }, { type: "keep" }],
      [{ kind: "transcribing" }, { type: "transcribeFailed" }],
      [{ kind: "summarizing" }, { type: "summaryFailed" }],
      [{ kind: "ready" }, { type: "generateSummary" }],
    ];
    for (const [status, event] of exits) {
      const next = step(meetingAt(status), event, T0 + 30 * MIN, config);
      expect(next.meeting?.status ?? null, status.kind).not.toEqual(status);
    }
  });

  test("recovery finalizes whatever a crash left and never starts capture", () => {
    const lastAudioAt = T0 + 45 * MIN;
    const cases: [MeetingStatus, MeetingStatus["kind"] | null][] = [
      [{ kind: "starting", from: "new" }, null],
      [{ kind: "starting", from: "paused" }, "transcribing"],
      [{ kind: "starting", from: "ready" }, "ready"],
      [{ kind: "recording", since: T0 + 30 * MIN }, "transcribing"],
      [{ kind: "paused" }, "transcribing"],
      [{ kind: "finishing" }, "transcribing"],
      [{ kind: "confirmingShort" }, "transcribing"],
      [{ kind: "transcribing" }, "transcribing"],
      [{ kind: "summarizing" }, "summarizing"],
      [{ kind: "ready" }, "ready"],
    ];
    for (const [status, after] of cases) {
      const { meeting, effects } = step(
        meetingAt(status),
        { type: "recover", lastAudioAt },
        T0 + 90 * MIN,
        config,
      );
      expect(meeting?.status.kind ?? null, status.kind).toBe(after);
      expect(kinds(effects), status.kind).not.toContain("startCapture");
    }
    const crashed = step(
      meetingAt({ kind: "recording", since: T0 + 30 * MIN }),
      { type: "recover", lastAudioAt },
      T0 + 90 * MIN,
      config,
    );
    expect(crashed.meeting?.spans.at(-1)).toEqual({
      startedAt: T0 + 30 * MIN,
      endedAt: lastAudioAt,
    });
    expect(crashed.effects).toEqual([{ type: "transcribeFinal" }]);
  });

  test("only an explicit start creates a meeting", () => {
    const events: MeetingEvent[] = [
      { type: "resume" },
      { type: "captureStarted", leg: 0 },
      { type: "recover", lastAudioAt: T0 },
      { type: "stop" },
    ];
    for (const event of events) {
      expect(step(null, event, T0, config)).toEqual({ meeting: null, effects: [] });
    }
  });
});

import { describe, expect, test } from "vite-plus/test";

import {
  AUTO_SUMMARY_MIN_MS,
  DEFAULT_MEETINGS_SETTINGS,
  summaryStale,
  type Meeting,
  type MeetingId,
  type MeetingStatus,
} from "../shared/meetings.ts";
import {
  maxLengthWarningMs,
  SILENCE_STOP_MS,
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
    finalPassFailed: false,
    transcriptRevision: 0,
    ...overrides,
  };
}

describe("meeting lifecycle", () => {
  test("a start asks for capture under a watchdog and records only once capture started", () => {
    const started = step(null, { type: "start", id: ID }, T0, config);
    expect(started.meeting?.status).toEqual({ kind: "starting", from: "new" });
    expect(started.effects).toEqual([
      { type: "watch", watch: "start" },
      { type: "startCapture", leg: 0 },
    ]);

    const live = step(started.meeting, { type: "captureStarted", leg: 0 }, T0 + 500, config);
    expect(live.meeting?.status).toEqual({ kind: "recording", since: T0 + 500 });
    expect(live.effects).toEqual([
      { type: "schedule", leg: 0, timer: "maxLengthWarning", inMs: 115 * MIN },
      { type: "schedule", leg: 0, timer: "maxLength", inMs: 120 * MIN },
    ]);
  });

  test("the length warning comes 2 minutes before a 30-minute limit and 5 before longer ones", () => {
    expect(maxLengthWarningMs("30m")).toBe(2 * MIN);
    for (const maxLength of ["1h", "2h", "3h"] as const) {
      expect(maxLengthWarningMs(maxLength)).toBe(5 * MIN);
    }
    const { effects } = play(
      [
        [{ type: "start", id: ID }, 0],
        [{ type: "captureStarted", leg: 0 }, 0],
      ],
      { config: { ...config, maxLength: "30m" } },
    );
    expect(effects).toContainEqual({
      type: "schedule",
      leg: 0,
      timer: "maxLengthWarning",
      inMs: 28 * MIN,
    });
  });

  test("a new meeting whose capture fails to start is deleted and the user told", () => {
    for (const failure of [
      { type: "captureFailed", leg: 0, message: "Recording could not start." },
      { type: "stalled", watch: "start" },
      { type: "helperExited" },
    ] satisfies MeetingEvent[]) {
      const { meeting, effects } = play([
        [{ type: "start", id: ID }, 0],
        [failure, 100],
      ]);
      expect(meeting, failure.type).toBeNull();
      expect(effects.at(-1)).toEqual({ type: "delete" });
      expect(notices(effects)).toEqual(["startFailed"]);
    }
  });

  test("stopping or discarding while starting a new meeting deletes it, which cancels capture", () => {
    for (const type of ["stop", "discard"] as const) {
      const { meeting, effects } = play([
        [{ type: "start", id: ID }, 0],
        [{ type }, 100],
      ]);
      expect(meeting).toBeNull();
      expect(kinds(effects)).toEqual(["watch", "startCapture", "delete"]);
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

  test("stopping a paused meeting asks for the drain that finishes it", () => {
    const stopped = step(meetingAt({ kind: "paused" }), { type: "stop" }, T0 + 30 * MIN, config);
    expect(stopped.meeting?.status).toEqual({ kind: "finishing" });
    expect(stopped.effects).toEqual([{ type: "drain" }, { type: "watch", watch: "drain" }]);
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

  test("a failed resume returns to where the meeting was, stops the capture and keeps it", () => {
    for (const from of ["paused", "ready"] as const) {
      const resumed = step(meetingAt({ kind: from }), { type: "resume" }, T0 + 30 * MIN, config);
      expect(resumed.meeting?.status).toEqual({ kind: "starting", from });
      for (const failure of [
        { type: "captureFailed", leg: 1, message: "busy" },
        { type: "stalled", watch: "start" },
      ] satisfies MeetingEvent[]) {
        const failed = step(resumed.meeting, failure, T0 + 30 * MIN, config);
        expect(failed.meeting?.status).toEqual({ kind: from });
        expect(kinds(failed.effects)).toEqual(["stopCapture", "notify"]);
        expect(notices(failed.effects)).toEqual(["resumeFailed"]);
        // A start that comes back late is stopped too.
        const late = step(
          failed.meeting,
          { type: "captureStarted", leg: 1 },
          T0 + 31 * MIN,
          config,
        );
        expect(late.meeting?.status).toEqual({ kind: from });
        expect(late.effects).toEqual([{ type: "stopCapture" }]);
      }
    }
  });

  test("lost capture pauses with a gap marker instead of recording again on its own", () => {
    for (const lost of [
      { type: "captureLost", leg: 0, loss: { source: "system", reason: "permission" } },
      { type: "helperExited" },
    ] satisfies MeetingEvent[]) {
      const { meeting, effects } = play([
        [{ type: "start", id: ID }, 0],
        [{ type: "captureStarted", leg: 0 }, 0],
        [lost, 7 * MIN],
      ]);
      expect(meeting?.status).toEqual({ kind: "paused" });
      expect(effects).toContainEqual({ type: "mark", marker: "gap" });
      expect(notices(effects)).toEqual(["captureLost"]);
      expect(kinds(effects).filter((kind) => kind === "startCapture")).toHaveLength(1);
    }
  });

  test("the max length warns, then ends the recording and finishes the meeting", () => {
    const short: LifecycleConfig = { ...config, maxLength: "30m" };
    const { meeting, effects } = play(
      [
        [{ type: "start", id: ID }, 0],
        [{ type: "captureStarted", leg: 0 }, 0],
        [{ type: "timer", leg: 0, timer: "maxLengthWarning" }, 28 * MIN],
        [{ type: "timer", leg: 0, timer: "maxLength" }, 30 * MIN],
      ],
      { config: short },
    );
    expect(effects).toContainEqual({
      type: "notify",
      notice: { kind: "maxLengthSoon", inMs: 2 * MIN },
    });
    expect(notices(effects)).toContain("maxLengthReached");
    expect(effects).toContainEqual({ type: "stopCapture" });
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

  test("ten minutes of silence prompts, and an unanswered prompt stops the recording", () => {
    const events: [MeetingEvent, number][] = [
      [{ type: "start", id: ID }, 0],
      [{ type: "captureStarted", leg: 0 }, 0],
      [{ type: "silence", leg: 0 }, 10 * MIN],
    ];
    const asked = play(events);
    expect(notices(asked.effects)).toEqual(["silence"]);
    expect(asked.effects).toContainEqual({
      type: "schedule",
      leg: 0,
      timer: "silenceStop",
      inMs: SILENCE_STOP_MS,
    });
    expect(asked.meeting?.status.kind).toBe("recording");

    const off = play(events, { config: { ...config, silencePrompt: false } });
    expect(notices(off.effects)).toEqual([]);
    expect(off.effects.some((e) => e.type === "schedule" && e.timer === "silenceStop")).toBe(false);

    const stopped = play([
      ...events,
      [{ type: "timer", leg: 0, timer: "silenceStop" }, 10.5 * MIN],
    ]);
    expect(stopped.meeting?.status).toEqual({ kind: "finishing" });
    expect(notices(stopped.effects)).toEqual(["silence", "silenceStopped"]);
    expect(stopped.effects).toContainEqual({ type: "stopCapture" });
  });

  test("a recording with only a few words asks before it is kept or discarded", () => {
    const short = play([...recording(1), [{ type: "drained", words: 3 }, MIN]]);
    expect(short.meeting?.status).toEqual({ kind: "confirmingShort" });

    const kept = step(short.meeting, { type: "keep" }, T0 + 2 * MIN, config);
    expect(kept.meeting?.status).toEqual({ kind: "transcribing", step: "finalizing" });
    expect(kept.effects).toEqual([{ type: "finalize" }, { type: "watch", watch: "finalPass" }]);

    const discarded = step(short.meeting, { type: "discard" }, T0 + 2 * MIN, config);
    expect(discarded.meeting).toBeNull();
    expect(discarded.effects).toEqual([{ type: "delete" }]);
  });

  test("a drain that stalls keeps the meeting rather than ask about it", () => {
    const stalled = step(
      meetingAt({ kind: "finishing" }),
      { type: "stalled", watch: "drain" },
      T0 + 21 * MIN,
      config,
    );
    expect(stalled.meeting?.status).toEqual({ kind: "transcribing", step: "finalizing" });
  });

  test("a watchdog from a phase that already ended changes nothing", () => {
    const finalizing = meetingAt({ kind: "transcribing", step: "finalizing" });
    for (const watch of ["start", "drain"] as const) {
      const next = step(finalizing, { type: "stalled", watch }, T0 + 21 * MIN, config);
      expect(next).toEqual({ meeting: finalizing, effects: [] });
    }
  });

  test("the final pass is written, then the audio deleted and the meeting summarized", () => {
    const segments = [
      { source: "mic", startMs: 0, endMs: 900, text: "Hi", speaker: null },
    ] as const;
    const finalizing = meetingAt({ kind: "transcribing", step: "finalizing" });
    const arrived = step(finalizing, { type: "finalPass", segments }, T0 + 21 * MIN, config);
    expect(arrived).toEqual({
      meeting: finalizing,
      effects: [{ type: "applyFinalPass", segments }],
    });
    const done = step(finalizing, { type: "finalized" }, T0 + 21 * MIN, config);
    expect(done.meeting?.status).toEqual({ kind: "summarizing", progress: null });
    expect(kinds(done.effects)).toEqual(["deleteAudio", "summarize"]);
  });

  test("a long meeting is summarized after the final pass, and a short one only gets a title until the user asks", () => {
    const long = play([
      ...recording(30),
      [{ type: "drained", words: 4000 }, 30 * MIN],
      [{ type: "finalized" }, 31 * MIN],
    ]);
    expect(long.meeting?.status).toEqual({ kind: "summarizing", progress: null });
    expect(kinds(long.effects)).toContain("summarize");

    const minutes = AUTO_SUMMARY_MIN_MS / MIN;
    const quick = play([
      ...recording(minutes),
      [{ type: "drained", words: 400 }, minutes * MIN],
      [{ type: "finalized" }, minutes * MIN],
    ]);
    expect(quick.meeting?.status).toEqual({ kind: "ready" });
    expect(kinds(quick.effects)).not.toContain("summarize");
    expect(kinds(quick.effects)).toContain("generateTitle");
    expect(kinds(long.effects)).not.toContain("generateTitle");

    const generating = step(quick.meeting, { type: "generateSummary" }, T0 + 6 * MIN, config);
    expect(generating.meeting?.status).toEqual({ kind: "summarizing", progress: null });
    expect(generating.effects).toEqual([{ type: "summarize" }]);
  });

  test("a failed final pass keeps the live transcript and the audio until the user retries or deletes it", () => {
    for (const failure of [
      { type: "finalizeFailed" },
      { type: "stalled", watch: "finalPass" },
    ] satisfies MeetingEvent[]) {
      const { meeting, effects } = play([
        ...recording(30),
        [{ type: "drained", words: 4000 }, 30 * MIN],
        [failure, 31 * MIN],
        [{ type: "summarized" }, 32 * MIN],
      ]);
      expect(notices(effects)).toEqual(["finalPassFailed", "summaryReady"]);
      expect(kinds(effects)).not.toContain("deleteAudio");
      expect(meeting?.status).toEqual({ kind: "ready" });
      expect(meeting?.finalPassFailed).toBe(true);

      // meeting-summary.ts wrote the summary meanwhile.
      const summary = { markdown: "Overview.", generatedAt: T0, coversUntilMs: 30 * MIN };
      const summarized = { ...meeting!, summary: { kind: "ready", summary } } satisfies Meeting;
      const retried = step(summarized, { type: "retryFinalPass" }, T0 + 40 * MIN, config);
      expect(retried.meeting?.status).toEqual({ kind: "transcribing", step: "finalizing" });
      const done = step(retried.meeting, { type: "finalized" }, T0 + 41 * MIN, config);
      expect(done.meeting?.finalPassFailed).toBe(false);
      expect(done.meeting?.status).toEqual({ kind: "ready" });
      expect(kinds(done.effects)).toContain("deleteAudio");

      const deleted = step(meeting, { type: "deleteAudio" }, T0 + 40 * MIN, config);
      expect(deleted.meeting).toEqual({ ...meeting, finalPassFailed: false });
      expect(deleted.effects).toEqual([{ type: "deleteAudio" }]);
    }
    const fine = meetingAt({ kind: "ready" });
    expect(step(fine, { type: "retryFinalPass" }, T0, config).effects).toEqual([]);
    expect(step(fine, { type: "deleteAudio" }, T0, config).effects).toEqual([]);
  });

  test("a helper that comes back gets the drain or final pass it lost", () => {
    const cases: [MeetingStatus, MeetingEffect["type"][]][] = [
      [{ kind: "finishing" }, ["drain", "watch"]],
      [{ kind: "transcribing", step: "draining" }, ["drain", "watch"]],
      [{ kind: "transcribing", step: "finalizing" }, ["finalize", "watch"]],
      [{ kind: "ready" }, []],
    ];
    for (const [status, effects] of cases) {
      const next = step(meetingAt(status), { type: "helperReady" }, T0 + 30 * MIN, config);
      expect(kinds(next.effects), status.kind).toEqual(effects);
    }
  });

  test("summary progress is shown on the summarizing status", () => {
    const next = step(
      meetingAt({ kind: "summarizing", progress: null }),
      { type: "summaryProgress", progress: { step: 2, total: 3 } },
      T0 + 25 * MIN,
      config,
    );
    expect(next.meeting?.status).toEqual({ kind: "summarizing", progress: { step: 2, total: 3 } });
  });

  test("a finished summary opens when the setting says so and leaves the summary to meeting-summary", () => {
    const summarizing = meetingAt({ kind: "summarizing", progress: null });
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
    const summarizing = meetingAt({ kind: "summarizing", progress: null });
    const failed = step(summarizing, { type: "summaryFailed" }, T0 + 25 * MIN, config);
    expect(failed.meeting).toEqual({ ...summarizing, status: { kind: "ready" } });
    expect(notices(failed.effects)).toEqual(["summaryFailed"]);
  });

  test("resuming a summarized meeting appends, leaves the summary stale and does not regenerate it", () => {
    const summary = { markdown: "Overview.", generatedAt: T0, coversUntilMs: 20 * MIN };
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
      [{ type: "finalized" }, 51 * MIN],
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

  test("resuming while the summary is written cancels it and records again", () => {
    const summarizing = meetingAt({ kind: "summarizing", progress: { step: 1, total: 2 } });
    const resumed = step(summarizing, { type: "resume" }, T0 + 30 * MIN, config);
    expect(resumed.meeting?.status).toEqual({ kind: "starting", from: "ready" });
    expect(kinds(resumed.effects)).toEqual(["cancelSummary", "watch", "startCapture"]);
  });

  test("a discard from a live meeting deletes it", () => {
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
      expect(effects).toEqual([{ type: "delete" }]);
    }
  });

  // One status of each kind; the Record makes a new kind fail to compile until it is listed.
  const everyStatus: Record<MeetingStatus["kind"], MeetingStatus[]> = {
    starting: [
      { kind: "starting", from: "new" },
      { kind: "starting", from: "paused" },
      { kind: "starting", from: "ready" },
    ],
    recording: [{ kind: "recording", since: T0 + 20 * MIN }],
    paused: [{ kind: "paused" }],
    finishing: [{ kind: "finishing" }],
    confirmingShort: [{ kind: "confirmingShort" }],
    transcribing: [
      { kind: "transcribing", step: "draining" },
      { kind: "transcribing", step: "finalizing" },
    ],
    summarizing: [{ kind: "summarizing", progress: null }],
    ready: [{ kind: "ready" }],
  };
  const statuses = Object.values(everyStatus).flat();

  test("a delete ends every status, and the delete effect is what cancels the helper", () => {
    for (const status of statuses) {
      const next = step(meetingAt(status), { type: "delete" }, T0 + 30 * MIN, config);
      expect(next, status.kind).toEqual({ meeting: null, effects: [{ type: "delete" }] });
    }
  });

  test("every status has a way out without a delete", () => {
    const exit = (status: MeetingStatus): MeetingEvent => {
      switch (status.kind) {
        case "starting":
          return { type: "stalled", watch: "start" };
        case "recording":
        case "paused":
          return { type: "stop" };
        case "finishing":
          return { type: "drained", words: 100 };
        case "confirmingShort":
          return { type: "keep" };
        case "transcribing":
          return status.step === "draining"
            ? { type: "stalled", watch: "drain" }
            : { type: "stalled", watch: "finalPass" };
        case "summarizing":
          return { type: "summaryFailed" };
        case "ready":
          return { type: "generateSummary" };
      }
    };
    for (const status of statuses) {
      const next = step(meetingAt(status), exit(status), T0 + 30 * MIN, config);
      expect(next.meeting?.status ?? null, status.kind).not.toEqual(status);
    }
  });

  test("recovery finalizes whatever a crash left and never starts capture", () => {
    const lastAudioAt = T0 + 45 * MIN;
    const draining = { kind: "transcribing", step: "draining" } as const;
    const cases: [MeetingStatus, MeetingStatus | null][] = [
      [{ kind: "starting", from: "new" }, null],
      [{ kind: "starting", from: "paused" }, draining],
      [{ kind: "starting", from: "ready" }, { kind: "ready" }],
      [{ kind: "recording", since: T0 + 30 * MIN }, draining],
      [{ kind: "paused" }, draining],
      [{ kind: "finishing" }, draining],
      [{ kind: "confirmingShort" }, draining],
      [draining, draining],
      [{ kind: "transcribing", step: "finalizing" }, draining],
      [
        { kind: "summarizing", progress: null },
        { kind: "summarizing", progress: null },
      ],
      [{ kind: "ready" }, { kind: "ready" }],
    ];
    for (const [status, after] of cases) {
      const { meeting, effects } = step(
        meetingAt(status),
        { type: "recover", lastAudioAt },
        T0 + 90 * MIN,
        config,
      );
      expect(meeting?.status ?? null, status.kind).toEqual(after);
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
    expect(crashed.effects).toEqual([{ type: "drain" }, { type: "watch", watch: "drain" }]);
  });

  test("only an explicit start creates a meeting", () => {
    const events: MeetingEvent[] = [
      { type: "resume" },
      { type: "captureStarted", leg: 0 },
      { type: "recover", lastAudioAt: T0 },
      { type: "stop" },
      { type: "delete" },
    ];
    for (const event of events) {
      expect(step(null, event, T0, config)).toEqual({ meeting: null, effects: [] });
    }
  });
});

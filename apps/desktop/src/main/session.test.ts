import { describe, expect, test } from "vite-plus/test";

import type { ModelStatus } from "../shared/api.ts";

import {
  ASR_DOWNLOADING_MESSAGE,
  ASR_MISSING_MESSAGE,
  HELPER_EXITED_MESSAGE,
  HELPER_TIMEOUT_MESSAGE,
  IDLE_AFTER_INSERTED_MS,
  IDLE_AFTER_OTHER_MS,
  idle,
  step,
  toPillState,
  type Effect,
  type Session,
  type SessionEvent,
} from "./session.ts";

const ID = "s1";

function run(events: [SessionEvent, number][], from: Session = idle) {
  let state = from;
  let effects: Effect[] = [];
  const all: Effect[] = [];
  for (const [event, now] of events) {
    ({ state, effects } = step(state, event, now));
    all.push(...effects);
  }
  return { state, effects, all };
}

const down = (now: number, asr: ModelStatus["state"] = "ready") =>
  [{ type: "hotkeyDown", id: ID, asr }, now] as [SessionEvent, number];
const up = (now: number) => [{ type: "hotkeyUp" }, now] as [SessionEvent, number];
const started = (now: number) =>
  [{ type: "captureStarted", id: ID }, now] as [SessionEvent, number];
const transcript = (text: string, cleanup: boolean, now = 2000) =>
  [{ type: "transcript", id: ID, text, cleanup }, now] as [SessionEvent, number];

const toRecording: [SessionEvent, number][] = [down(0), started(50)];
const toTranscribing: [SessionEvent, number][] = [...toRecording, up(1000)];
const toCleaning: [SessionEvent, number][] = [
  ...toTranscribing,
  transcript("hello um world", true),
];
const toInserting: [SessionEvent, number][] = [...toTranscribing, transcript("hello world", false)];

const types = (effects: Effect[]) => effects.map((effect) => effect.type);

describe("starting a session", () => {
  test("hotkey down in idle starts capture", () => {
    const { state, effects } = run([down(0)]);
    expect(state).toEqual({ phase: "starting", id: ID, pressedAt: 0, releasedAt: null });
    expect(effects).toEqual([{ type: "startCapture", id: ID }]);
  });

  test("hotkey down while done starts a new session", () => {
    const { state, effects } = run([
      ...toInserting,
      [{ type: "insertResult", id: ID, method: "paste", reason: null }, 2100],
      [{ type: "hotkeyDown", id: "s2", asr: "ready" }, 2200],
    ]);
    expect(state).toEqual({ phase: "starting", id: "s2", pressedAt: 2200, releasedAt: null });
    expect(effects).toEqual([{ type: "startCapture", id: "s2" }]);
  });

  test.each(["missing", "failed"] as const)(
    "hotkey down with ASR %s never starts capture",
    (asr) => {
      const { state, all } = run([down(0, asr)]);
      expect(state).toEqual({
        phase: "done",
        id: ID,
        outcome: { kind: "failed", message: ASR_MISSING_MESSAGE },
      });
      expect(types(all)).not.toContain("startCapture");
      expect(all).toContainEqual({ type: "scheduleIdle", id: ID, ms: IDLE_AFTER_OTHER_MS });
    },
  );

  test("hotkey down with ASR downloading never starts capture and says so", () => {
    const { state, all } = run([down(0, "downloading")]);
    expect(state).toEqual({
      phase: "done",
      id: ID,
      outcome: { kind: "failed", message: ASR_DOWNLOADING_MESSAGE },
    });
    expect(types(all)).not.toContain("startCapture");
  });

  test("hotkey down with ASR loading starts capture", () => {
    expect(run([down(0, "loading")]).effects).toEqual([{ type: "startCapture", id: ID }]);
  });

  test("a second hotkey down mid-session is ignored", () => {
    for (const path of [[down(0)], toRecording, toTranscribing, toCleaning, toInserting]) {
      const before = run(path).state;
      const { state, effects } = run([
        ...path,
        [{ type: "hotkeyDown", id: "s2", asr: "ready" }, 3000],
      ]);
      expect(state).toEqual(before);
      expect(effects).toEqual([]);
    }
  });
});

describe("hold and release", () => {
  test("capture.started moves to recording", () => {
    expect(run(toRecording).state).toEqual({ phase: "recording", id: ID, pressedAt: 0 });
  });

  test("release before capture.started stops as soon as capture starts", () => {
    const afterUp = run([down(0), up(300)]);
    expect(afterUp.state).toEqual({ phase: "starting", id: ID, pressedAt: 0, releasedAt: 300 });
    expect(afterUp.effects).toEqual([]);
    const { state, effects } = run([down(0), up(300), started(350)]);
    expect(state).toEqual({ phase: "transcribing", id: ID });
    expect(effects).toEqual([{ type: "stopCapture", id: ID, releasedAt: 300 }]);
  });

  test("a tap released before capture.started is tooShort once capture starts", () => {
    const { state, effects } = run([down(0), up(249), started(400)]);
    expect(state).toEqual({ phase: "done", id: ID, outcome: { kind: "tooShort" } });
    expect(effects).toEqual([
      { type: "cancelCapture", id: ID },
      { type: "scheduleIdle", id: ID, ms: IDLE_AFTER_OTHER_MS },
    ]);
    expect(types(effects)).not.toContain("stopCapture");
  });

  test("capture that never starts times out failed and cancels the helper", () => {
    const { state, effects } = run([down(0), [{ type: "timedOut", id: ID }, 3000]]);
    expect(state).toEqual({
      phase: "done",
      id: ID,
      outcome: { kind: "failed", message: HELPER_TIMEOUT_MESSAGE },
    });
    expect(effects).toEqual([
      { type: "cancelCapture", id: ID },
      { type: "scheduleIdle", id: ID, ms: IDLE_AFTER_OTHER_MS },
    ]);
  });

  test("a hold shorter than 250 ms cancels capture as tooShort", () => {
    const { state, effects } = run([down(0), started(50), up(249)]);
    expect(state).toEqual({ phase: "done", id: ID, outcome: { kind: "tooShort" } });
    expect(effects).toEqual([
      { type: "cancelCapture", id: ID },
      { type: "scheduleIdle", id: ID, ms: IDLE_AFTER_OTHER_MS },
    ]);
  });

  test("a hold of 250 ms or more stops capture and transcribes", () => {
    const { state, effects } = run([down(0), started(50), up(250)]);
    expect(state).toEqual({ phase: "transcribing", id: ID });
    expect(effects).toEqual([{ type: "stopCapture", id: ID, releasedAt: 250 }]);
  });

  test("Escape during starting cancels capture and returns straight to idle", () => {
    const { state, effects } = run([down(0), [{ type: "cancel" }, 100]]);
    expect(state).toEqual(idle);
    expect(effects).toEqual([{ type: "cancelCapture", id: ID }]);
  });

  test("Escape during recording cancels capture and returns straight to idle", () => {
    const { state, effects } = run([...toRecording, [{ type: "cancel" }, 800]]);
    expect(state).toEqual(idle);
    expect(effects).toEqual([{ type: "cancelCapture", id: ID }]);
  });

  test("Escape while processing is ignored", () => {
    const { state, effects } = run([...toTranscribing, [{ type: "cancel" }, 1100]]);
    expect(state).toEqual({ phase: "transcribing", id: ID });
    expect(effects).toEqual([]);
  });

  test("capture failure ends the session failed with the helper's message", () => {
    const { state, effects } = run([
      down(0),
      [{ type: "captureFailed", id: ID, message: "no mic" }, 60],
    ]);
    expect(state).toEqual({
      phase: "done",
      id: ID,
      outcome: { kind: "failed", message: "no mic" },
    });
    expect(effects).toEqual([{ type: "scheduleIdle", id: ID, ms: IDLE_AFTER_OTHER_MS }]);
  });
});

describe("transcript", () => {
  test("an empty transcript ends empty without inserting", () => {
    const { state, all } = run([...toTranscribing, transcript("  ", true)]);
    expect(state).toEqual({ phase: "done", id: ID, outcome: { kind: "empty" } });
    expect(types(all)).not.toContain("insert");
    expect(types(all)).not.toContain("cleanup");
  });

  test("with cleanup on, the raw text is remembered and sent to cleanup", () => {
    const { state, effects } = run(toCleaning);
    expect(state).toEqual({ phase: "cleaning", id: ID, raw: "hello um world" });
    expect(effects).toEqual([
      { type: "remember", raw: "hello um world", text: "hello um world" },
      { type: "cleanup", id: ID, raw: "hello um world" },
    ]);
  });

  test("with cleanup off, the raw text is remembered and inserted", () => {
    const { state, effects } = run(toInserting);
    expect(state).toEqual({ phase: "inserting", id: ID, raw: "hello world", text: "hello world" });
    expect(effects).toEqual([
      { type: "remember", raw: "hello world", text: "hello world" },
      { type: "insert", id: ID, text: "hello world" },
    ]);
  });

  test("a transcript while still recording proceeds like a normal stop and the later release is ignored", () => {
    const { state, effects } = run([...toRecording, transcript("long dictation", false, 600_000)]);
    expect(state).toEqual({
      phase: "inserting",
      id: ID,
      raw: "long dictation",
      text: "long dictation",
    });
    expect(effects).toEqual([
      { type: "remember", raw: "long dictation", text: "long dictation" },
      { type: "insert", id: ID, text: "long dictation" },
    ]);
    expect(step(state, { type: "hotkeyUp" }, 600_100)).toEqual({ state, effects: [] });
  });

  test("transcription failure ends failed", () => {
    const { state } = run([
      ...toTranscribing,
      [{ type: "transcriptFailed", id: ID, message: "asr down" }, 2000],
    ]);
    expect(state).toEqual({
      phase: "done",
      id: ID,
      outcome: { kind: "failed", message: "asr down" },
    });
  });

  test("transcription failure while still recording ends failed instead of listening forever", () => {
    const { state } = run([
      ...toRecording,
      [{ type: "transcriptFailed", id: ID, message: "asr down" }, 2000],
    ]);
    expect(state).toEqual({
      phase: "done",
      id: ID,
      outcome: { kind: "failed", message: "asr down" },
    });
  });
});

describe("capture the helper stops on its own", () => {
  const stopped = (now: number) =>
    [{ type: "captureStopped", id: ID }, now] as [SessionEvent, number];

  test("leaves listening at once, commands nothing, and ignores the release of the still-held key", () => {
    const { state, effects } = run([...toRecording, stopped(600_000)]);
    expect(state).toEqual({ phase: "transcribing", id: ID });
    expect(toPillState(state)).toEqual({ kind: "processing" });
    expect(effects).toEqual([]);
    expect(step(state, { type: "hotkeyUp" }, 600_100)).toEqual({ state, effects: [] });
  });

  test("the transcript of the capture so far is inserted, and a release after that is still ignored", () => {
    const { state, effects } = run([
      ...toRecording,
      stopped(600_000),
      transcript("long dictation", false, 600_500),
    ]);
    expect(state).toEqual({
      phase: "inserting",
      id: ID,
      raw: "long dictation",
      text: "long dictation",
    });
    expect(effects).toEqual([
      { type: "remember", raw: "long dictation", text: "long dictation" },
      { type: "insert", id: ID, text: "long dictation" },
    ]);
    expect(step(state, { type: "hotkeyUp" }, 600_600)).toEqual({ state, effects: [] });
  });

  test("a stop reported in any other phase changes nothing", () => {
    for (const from of [run([down(0)]).state, run(toTranscribing).state, run(toCleaning).state]) {
      expect(step(from, { type: "captureStopped", id: ID }, 5000)).toEqual({
        state: from,
        effects: [],
      });
    }
  });
});

describe("cleanup", () => {
  test("cleaned text is remembered and inserted", () => {
    const { state, effects } = run([
      ...toCleaning,
      [{ type: "cleaned", id: ID, text: "Hello, world." }, 2300],
    ]);
    expect(state).toEqual({
      phase: "inserting",
      id: ID,
      raw: "hello um world",
      text: "Hello, world.",
    });
    expect(effects).toEqual([
      { type: "remember", raw: "hello um world", text: "Hello, world." },
      { type: "insert", id: ID, text: "Hello, world." },
    ]);
  });

  test("cleanup failure inserts the raw text", () => {
    const { state, effects } = run([...toCleaning, [{ type: "cleanupFailed", id: ID }, 2300]]);
    expect(state).toEqual({
      phase: "inserting",
      id: ID,
      raw: "hello um world",
      text: "hello um world",
    });
    expect(effects).toContainEqual({ type: "insert", id: ID, text: "hello um world" });
  });

  test("cleanup returning empty for filler input ends empty and keeps the raw transcript", () => {
    const { state, all } = run([...toCleaning, [{ type: "cleaned", id: ID, text: "" }, 2300]]);
    expect(state).toEqual({ phase: "done", id: ID, outcome: { kind: "empty" } });
    expect(types(all)).not.toContain("insert");
    expect(all).toContainEqual({ type: "remember", raw: "hello um world", text: "hello um world" });
  });
});

describe("insertion", () => {
  test.each(["accessibility", "paste"] as const)(
    "%s insert ends inserted with a short idle delay",
    (method) => {
      const { state, effects } = run([
        ...toInserting,
        [{ type: "insertResult", id: ID, method, reason: null }, 2100],
      ]);
      expect(state).toEqual({ phase: "done", id: ID, outcome: { kind: "inserted", method } });
      expect(effects).toEqual([{ type: "scheduleIdle", id: ID, ms: IDLE_AFTER_INSERTED_MS }]);
    },
  );

  test("focusChanged ends notInserted and keeps the remembered text", () => {
    const { state, all, effects } = run([
      ...toInserting,
      [{ type: "insertResult", id: ID, method: "none", reason: "focusChanged" }, 2100],
    ]);
    expect(state).toEqual({
      phase: "done",
      id: ID,
      outcome: { kind: "notInserted", reason: "focusChanged" },
    });
    expect(all).toContainEqual({ type: "remember", raw: "hello world", text: "hello world" });
    expect(effects).toEqual([{ type: "scheduleIdle", id: ID, ms: IDLE_AFTER_OTHER_MS }]);
  });
});

describe("idle and stale events", () => {
  test("idle timeout for the done session returns to idle", () => {
    const done = run([
      ...toInserting,
      [{ type: "insertResult", id: ID, method: "paste", reason: null }, 2100],
    ]);
    expect(step(done.state, { type: "idleTimeout", id: ID }, 3300)).toEqual({
      state: idle,
      effects: [],
    });
  });

  test("idle timeout for an earlier session does not end the current one", () => {
    const { state } = run([...toRecording, [{ type: "idleTimeout", id: "s0" }, 500]]);
    expect(state).toEqual({ phase: "recording", id: ID, pressedAt: 0 });
  });

  test("events for a stale session id are dropped", () => {
    const stale: SessionEvent[] = [
      { type: "captureStarted", id: "old" },
      { type: "captureFailed", id: "old", message: "x" },
      { type: "transcript", id: "old", text: "late words", cleanup: false },
      { type: "insertResult", id: "old", method: "paste", reason: null },
    ];
    for (const event of stale) {
      const { state, effects } = run([...toRecording, [event, 900]]);
      expect(state).toEqual({ phase: "recording", id: ID, pressedAt: 0 });
      expect(effects).toEqual([]);
    }
    expect(step(idle, { type: "transcript", id: "old", text: "late", cleanup: false }, 0)).toEqual({
      state: idle,
      effects: [],
    });
  });

  test("helper exit mid-recording ends failed without commanding the helper", () => {
    const { state, effects } = run([...toRecording, [{ type: "helperExited" }, 700]]);
    expect(state).toEqual({
      phase: "done",
      id: ID,
      outcome: { kind: "failed", message: HELPER_EXITED_MESSAGE },
    });
    expect(effects).toEqual([{ type: "scheduleIdle", id: ID, ms: IDLE_AFTER_OTHER_MS }]);
  });

  test("a transcription that never answers times out as failed and cancels the helper", () => {
    const { state, effects } = run([...toTranscribing, [{ type: "timedOut", id: ID }, 40_000]]);
    expect(state).toEqual({
      phase: "done",
      id: ID,
      outcome: { kind: "failed", message: HELPER_TIMEOUT_MESSAGE },
    });
    expect(effects).toEqual([
      { type: "cancelCapture", id: ID },
      { type: "scheduleIdle", id: ID, ms: IDLE_AFTER_OTHER_MS },
    ]);
  });

  test("a transcript that lands after the timeout is remembered but not inserted", () => {
    const timedOut = run([...toTranscribing, [{ type: "timedOut", id: ID }, 40_000]]).state;
    const { state, effects } = run([transcript("late words", true, 41_000)], timedOut);
    expect(state).toBe(timedOut);
    expect(effects).toEqual([{ type: "remember", raw: "late words", text: "late words" }]);
    expect(run([transcript("   ", true, 41_000)], timedOut).effects).toEqual([]);
    expect(
      step(timedOut, { type: "transcript", id: "s2", text: "x", cleanup: false }, 41_000),
    ).toEqual({ state: timedOut, effects: [] });
  });

  test("an insert that never answers times out as notInserted with the text remembered", () => {
    const { state, all } = run([...toInserting, [{ type: "timedOut", id: ID }, 8000]]);
    expect(state).toEqual({
      phase: "done",
      id: ID,
      outcome: { kind: "notInserted", reason: "failed" },
    });
    expect(all).toContainEqual({ type: "remember", raw: "hello world", text: "hello world" });
  });

  test("a timeout while recording or for another session changes nothing", () => {
    expect(run([...toRecording, [{ type: "timedOut", id: ID }, 500]]).state).toEqual({
      phase: "recording",
      id: ID,
      pressedAt: 0,
    });
    expect(run([...toTranscribing, [{ type: "timedOut", id: "old" }, 500]]).state).toEqual({
      phase: "transcribing",
      id: ID,
    });
  });

  test("helper exit while idle or done changes nothing", () => {
    expect(step(idle, { type: "helperExited" }, 0)).toEqual({ state: idle, effects: [] });
    const done = run([...toTranscribing, transcript("", true)]).state;
    expect(step(done, { type: "helperExited" }, 0)).toEqual({ state: done, effects: [] });
  });
});

describe("pill projection", () => {
  test("only an active capture shows as listening", () => {
    expect(toPillState(idle)).toEqual({ kind: "idle" });
    expect(toPillState(run([down(0)]).state)).toEqual({ kind: "idle" });
    expect(toPillState(run(toRecording).state)).toEqual({ kind: "listening" });
    expect(toPillState(run(toTranscribing).state)).toEqual({ kind: "processing" });
    expect(toPillState(run(toCleaning).state)).toEqual({ kind: "processing" });
    expect(toPillState(run(toInserting).state)).toEqual({ kind: "processing" });
    expect(toPillState(run([down(0, "missing")]).state)).toEqual({
      kind: "done",
      outcome: { kind: "failed", message: ASR_MISSING_MESSAGE },
    });
  });
});

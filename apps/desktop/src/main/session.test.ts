import { describe, expect, test } from "vite-plus/test";

import type { ModelStatus } from "../shared/api.ts";
import type { DictionaryEntry } from "../shared/dictionary.ts";
import type { Rewrites } from "../shared/rewrite.ts";
import type { Snippet } from "../shared/snippets.ts";
import { POLISH_ID } from "../shared/transforms.ts";

import {
  ASR_DOWNLOADING_MESSAGE,
  ASR_MISSING_MESSAGE,
  HELPER_EXITED_MESSAGE,
  HELPER_TIMEOUT_MESSAGE,
  IDLE_AFTER_INSERTED_MS,
  IDLE_AFTER_OTHER_MS,
  TRANSCRIBE_GAVE_UP_MESSAGE,
  idle,
  step,
  toPillState,
  type CleanupWork,
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
const chord = (now: number) => [{ type: "hotkeyChord" }, now] as [SessionEvent, number];
const tap = (now: number, asr: ModelStatus["state"] = "ready") =>
  [{ type: "toggle", id: ID, asr }, now] as [SessionEvent, number];
const escape = (now: number) => [{ type: "cancel" }, now] as [SessionEvent, number];
const started = (now: number) =>
  [{ type: "captureStarted", id: ID }, now] as [SessionEvent, number];
const NONE: Rewrites = { dictionary: [], snippets: [] };
const STYLE: CleanupWork = { kind: "style", style: { style: "casual", layout: "general" } };
const transcript = (
  text: string,
  cleanup: CleanupWork | null,
  now = 2000,
  rewrites = NONE,
  copyToClipboard = false,
) =>
  [
    { type: "transcript", id: ID, text, cleanup, rewrites, destination: null, copyToClipboard },
    now,
  ] as [SessionEvent, number];

const toRecording: [SessionEvent, number][] = [down(0), started(50)];
const toTranscribing: [SessionEvent, number][] = [...toRecording, up(1000)];
const toOverdue: [SessionEvent, number][] = [
  ...toTranscribing,
  [{ type: "timedOut", id: ID }, 31_000],
];
const toGaveUp: [SessionEvent, number][] = [...toOverdue, [{ type: "timedOut", id: ID }, 61_000]];
const toCleaning: [SessionEvent, number][] = [
  ...toTranscribing,
  transcript("hello um world", STYLE),
];
const toInserting: [SessionEvent, number][] = [...toTranscribing, transcript("hello world", null)];

const types = (effects: Effect[]) =>
  effects.map((effect) => (effect.type === "send" ? effect.command.type : effect.type));
const remembered = (raw: string, text: string, id = ID): Effect => ({
  type: "remember",
  id,
  raw,
  text,
  status: "pending",
});
const rememberedLate = (raw: string, id: string): Effect => ({
  type: "remember",
  id,
  raw,
  text: raw,
  status: "notInserted",
});
const copy = (text: string): Effect => ({ type: "copy", output: { text, html: null } });
const dictated = (raw: string, dictionaryFixes = 0): Effect => ({
  type: "dictated",
  id: ID,
  raw,
  insertedCleanup: null,
  dictionaryFixes,
  destination: null,
});

describe("a second transcript for the same session", () => {
  test("changes nothing while the first is being cleaned", () => {
    const { state, effects } = run([...toCleaning, transcript("hello um world", STYLE, 2500)]);
    expect(state.phase).toBe("cleaning");
    expect(effects).toEqual([]);
  });

  test("changes nothing while the first is being inserted", () => {
    const { state, effects } = run([...toInserting, transcript("hello world", null, 2500)]);
    expect(state.phase).toBe("inserting");
    expect(effects).toEqual([]);
  });
});

describe("starting a session", () => {
  test("hotkey down in idle starts capture", () => {
    const { state, effects } = run([down(0)]);
    expect(state).toEqual({
      phase: "starting",
      id: ID,
      mode: "hold",
      pressedAt: 0,
      released: null,
    });
    expect(effects).toEqual([{ type: "send", command: { type: "capture.start", id: ID } }]);
  });

  test("hotkey down while done starts a new session", () => {
    const { state, effects } = run([
      ...toInserting,
      [{ type: "insertResult", id: ID, method: "paste", reason: null }, 2100],
      [{ type: "hotkeyDown", id: "s2", asr: "ready" }, 2200],
    ]);
    expect(state).toEqual({
      phase: "starting",
      id: "s2",
      mode: "hold",
      pressedAt: 2200,
      released: null,
    });
    expect(effects).toEqual([{ type: "send", command: { type: "capture.start", id: "s2" } }]);
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
      expect(types(all)).not.toContain("capture.start");
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
    expect(types(all)).not.toContain("capture.start");
  });

  test("hotkey down with ASR loading starts capture", () => {
    expect(run([down(0, "loading")]).effects).toEqual([
      { type: "send", command: { type: "capture.start", id: ID } },
    ]);
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
    expect(run(toRecording).state).toEqual({
      phase: "recording",
      id: ID,
      mode: "hold",
      pressedAt: 0,
    });
  });

  test("release before capture.started stops as soon as capture starts", () => {
    const afterUp = run([down(0), up(300)]);
    expect(afterUp.state).toEqual({
      phase: "starting",
      id: ID,
      mode: "hold",
      pressedAt: 0,
      released: { at: 300 },
    });
    expect(afterUp.effects).toEqual([]);
    const { state, effects } = run([down(0), up(300), started(350)]);
    expect(state).toEqual({ phase: "transcribing", id: ID, overdue: false });
    expect(effects).toEqual([
      { type: "send", command: { type: "capture.stop", id: ID, releasedAt: 300 } },
    ]);
  });

  test("each capture command echoes the clock of the hotkey event that caused it", () => {
    const pressed: [SessionEvent, number] = [
      { type: "hotkeyDown", id: ID, asr: "ready", hotkeyUptimeMs: 1000.5 },
      0,
    ];
    const released: [SessionEvent, number] = [{ type: "hotkeyUp", hotkeyUptimeMs: 1300.5 }, 300];
    const stop = {
      type: "send",
      command: { type: "capture.stop", id: ID, releasedAt: 300, hotkeyUptimeMs: 1300.5 },
    };
    expect(run([pressed]).effects).toEqual([
      { type: "send", command: { type: "capture.start", id: ID, hotkeyUptimeMs: 1000.5 } },
    ]);
    expect(run([pressed, released, started(350)]).effects).toEqual([stop]);
    expect(run([pressed, started(50), released]).effects).toEqual([stop]);
  });

  test("a tap released before capture.started is tooShort once capture starts", () => {
    const { state, effects } = run([down(0), up(249), started(400)]);
    expect(state).toEqual({ phase: "done", id: ID, outcome: { kind: "tooShort" } });
    expect(effects).toEqual([
      { type: "send", command: { type: "capture.cancel", id: ID } },
      { type: "scheduleIdle", id: ID, ms: IDLE_AFTER_OTHER_MS },
    ]);
    expect(types(effects)).not.toContain("capture.stop");
  });

  test("capture that never starts times out failed and cancels the helper", () => {
    const { state, effects } = run([down(0), [{ type: "timedOut", id: ID }, 3000]]);
    expect(state).toEqual({
      phase: "done",
      id: ID,
      outcome: { kind: "failed", message: HELPER_TIMEOUT_MESSAGE },
    });
    expect(effects).toEqual([
      { type: "send", command: { type: "capture.cancel", id: ID } },
      { type: "scheduleIdle", id: ID, ms: IDLE_AFTER_OTHER_MS },
    ]);
  });

  test("a hold shorter than 250 ms cancels capture as tooShort", () => {
    const { state, effects } = run([down(0), started(50), up(249)]);
    expect(state).toEqual({ phase: "done", id: ID, outcome: { kind: "tooShort" } });
    expect(effects).toEqual([
      { type: "send", command: { type: "capture.cancel", id: ID } },
      { type: "scheduleIdle", id: ID, ms: IDLE_AFTER_OTHER_MS },
    ]);
  });

  test("a hold of 250 ms or more stops capture and transcribes", () => {
    const { state, effects } = run([down(0), started(50), up(250)]);
    expect(state).toEqual({ phase: "transcribing", id: ID, overdue: false });
    expect(effects).toEqual([
      { type: "send", command: { type: "capture.stop", id: ID, releasedAt: 250 } },
    ]);
  });

  test("Escape during starting cancels capture and returns straight to idle", () => {
    const { state, effects } = run([down(0), escape(100)]);
    expect(state).toEqual(idle);
    expect(effects).toEqual([{ type: "send", command: { type: "capture.cancel", id: ID } }]);
  });

  test("Escape during recording cancels capture and returns straight to idle", () => {
    const { state, effects } = run([...toRecording, escape(800)]);
    expect(state).toEqual(idle);
    expect(effects).toEqual([{ type: "send", command: { type: "capture.cancel", id: ID } }]);
  });

  test("Escape while processing is ignored", () => {
    const { state, effects } = run([...toTranscribing, escape(1100)]);
    expect(state).toEqual({ phase: "transcribing", id: ID, overdue: false });
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

describe("toggle dictation", () => {
  const toToggleRecording: [SessionEvent, number][] = [tap(0), started(50)];

  test("a tap starts capture and a second tap stops and transcribes", () => {
    const recording = run(toToggleRecording);
    expect(recording.state).toEqual({ phase: "recording", id: ID, mode: "toggle", pressedAt: 0 });
    expect(recording.all).toEqual([{ type: "send", command: { type: "capture.start", id: ID } }]);
    const { state, effects } = run([...toToggleRecording, tap(4000)]);
    expect(state).toEqual({ phase: "transcribing", id: ID, overdue: false });
    expect(effects).toEqual([
      { type: "send", command: { type: "capture.stop", id: ID, releasedAt: 4000 } },
    ]);
  });

  test("a second tap before capture starts stops once capture starts", () => {
    const tappedTwice = run([tap(0), tap(400)]);
    expect(tappedTwice.state).toMatchObject({ phase: "starting", released: { at: 400 } });
    expect(tappedTwice.effects).toEqual([]);
    const { state, all } = run([tap(0), tap(400), tap(450), started(500)]);
    expect(state).toEqual({ phase: "transcribing", id: ID, overdue: false });
    expect(
      all.filter((effect) => effect.type === "send" && effect.command.type === "capture.stop"),
    ).toEqual([{ type: "send", command: { type: "capture.stop", id: ID, releasedAt: 400 } }]);
  });

  test("a double tap under 250 ms cancels as tooShort", () => {
    const { state, effects } = run([tap(0), started(50), tap(200)]);
    expect(state).toEqual({ phase: "done", id: ID, outcome: { kind: "tooShort" } });
    expect(types(effects)).toEqual(["capture.cancel", "scheduleIdle"]);
  });

  test("a tap with no usable model fails the way a hold press does", () => {
    expect(run([tap(0, "missing")]).state).toEqual(run([down(0, "missing")]).state);
    expect(run([tap(0, "downloading")]).state).toEqual(run([down(0, "downloading")]).state);
  });

  test("a tap after a finished session starts a new one", () => {
    const done = run([...toToggleRecording, tap(100)]).state;
    expect(done.phase).toBe("done");
    expect(step(done, tap(5000)[0], 5000).effects).toEqual([
      { type: "send", command: { type: "capture.start", id: ID } },
    ]);
  });

  test("the hold key's press, release, or chord leaves a toggle session recording", () => {
    const before = run(toToggleRecording).state;
    for (const event of [chord(3000), down(3000), up(3100)]) {
      const { state, effects } = run([...toToggleRecording, event]);
      expect(state).toEqual(before);
      expect(effects).toEqual([]);
    }
  });

  test("Escape cancels a toggle session, before or after capture starts", () => {
    for (const events of [[tap(0)], toToggleRecording]) {
      const { state, effects } = run([...events, escape(5000)]);
      expect(state).toEqual(idle);
      expect(effects).toEqual([{ type: "send", command: { type: "capture.cancel", id: ID } }]);
    }
  });

  test("a tap during a hold session is ignored", () => {
    for (const events of [[down(0)], toRecording]) {
      const before = run(events).state;
      const { state, effects } = run([...events, tap(600)]);
      expect(state).toEqual(before);
      expect(effects).toEqual([]);
    }
  });

  test("a chord on the hold key cancels a hold session", () => {
    const { state, effects } = run([...toRecording, chord(600)]);
    expect(state).toEqual(idle);
    expect(effects).toEqual([{ type: "send", command: { type: "capture.cancel", id: ID } }]);
  });
});

describe("transcript", () => {
  test("an empty transcript ends empty without inserting", () => {
    const { state, all } = run([...toTranscribing, transcript("  ", STYLE)]);
    expect(state).toEqual({ phase: "done", id: ID, outcome: { kind: "empty" } });
    expect(types(all)).not.toContain("insert");
    expect(types(all)).not.toContain("cleanup");
  });

  test("with cleanup on, the raw text is remembered and sent to cleanup", () => {
    const { state, effects } = run(toCleaning);
    expect(state.phase).toBe("cleaning");
    expect(effects).toEqual([
      remembered("hello um world", "hello um world"),
      { type: "cleanup", id: ID, raw: "hello um world", work: STYLE },
    ]);
  });

  test("with cleanup off, the raw text is remembered and inserted", () => {
    const { state, effects } = run(toInserting);
    expect(state).toEqual({
      phase: "inserting",
      id: ID,
      raw: "hello world",
      output: { text: "hello world", html: null },
      insertedCleanup: null,
      dictionaryFixes: 0,
      destination: null,
      copyToClipboard: false,
    });
    expect(effects).toEqual([
      remembered("hello world", "hello world"),
      {
        type: "send",
        command: { type: "insert", id: ID, output: { text: "hello world", html: null } },
      },
    ]);
  });

  test("a transcript while still recording proceeds like a normal stop and the later release is ignored", () => {
    const { state, effects } = run([...toRecording, transcript("long dictation", null, 600_000)]);
    expect(state).toEqual({
      phase: "inserting",
      id: ID,
      raw: "long dictation",
      output: { text: "long dictation", html: null },
      insertedCleanup: null,
      dictionaryFixes: 0,
      destination: null,
      copyToClipboard: false,
    });
    expect(effects).toEqual([
      remembered("long dictation", "long dictation"),
      {
        type: "send",
        command: { type: "insert", id: ID, output: { text: "long dictation", html: null } },
      },
    ]);
    expect(step(state, { type: "hotkeyUp" }, 600_100)).toEqual({
      state,
      effects: [],
    });
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
    expect(state).toEqual({ phase: "transcribing", id: ID, overdue: false });
    expect(toPillState(state)).toEqual({ kind: "processing", overdue: false });
    expect(effects).toEqual([]);
    expect(step(state, { type: "hotkeyUp" }, 600_100)).toEqual({
      state,
      effects: [],
    });
  });

  test("the transcript of the capture so far is inserted, and a release after that is still ignored", () => {
    const { state, effects } = run([
      ...toRecording,
      stopped(600_000),
      transcript("long dictation", null, 600_500),
    ]);
    expect(state).toEqual({
      phase: "inserting",
      id: ID,
      raw: "long dictation",
      output: { text: "long dictation", html: null },
      insertedCleanup: null,
      dictionaryFixes: 0,
      destination: null,
      copyToClipboard: false,
    });
    expect(effects).toEqual([
      remembered("long dictation", "long dictation"),
      {
        type: "send",
        command: { type: "insert", id: ID, output: { text: "long dictation", html: null } },
      },
    ]);
    expect(step(state, { type: "hotkeyUp" }, 600_600)).toEqual({
      state,
      effects: [],
    });
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
      output: { text: "Hello, world.", html: null },
      insertedCleanup: "Hello, world.",
      dictionaryFixes: 0,
      destination: null,
      copyToClipboard: false,
    });
    expect(effects).toEqual([
      remembered("hello um world", "Hello, world."),
      {
        type: "send",
        command: { type: "insert", id: ID, output: { text: "Hello, world.", html: null } },
      },
    ]);
  });

  test("cleanup failure inserts the raw text", () => {
    const { state, effects } = run([...toCleaning, [{ type: "cleanupFailed", id: ID }, 2300]]);
    expect(state).toEqual({
      phase: "inserting",
      id: ID,
      raw: "hello um world",
      output: { text: "hello um world", html: null },
      insertedCleanup: null,
      dictionaryFixes: 0,
      destination: null,
      copyToClipboard: false,
    });
    expect(effects).toContainEqual({
      type: "send",
      command: { type: "insert", id: ID, output: { text: "hello um world", html: null } },
    });
  });

  test("an auto-apply transform gets the raw transcript, and its result is inserted but not counted as cleanup", () => {
    const POLISH: CleanupWork = { kind: "transform", transformId: POLISH_ID };
    const toTransforming = [...toTranscribing, transcript("hello um world", POLISH)];
    expect(run(toTransforming).effects).toEqual([
      remembered("hello um world", "hello um world"),
      { type: "cleanup", id: ID, raw: "hello um world", work: POLISH },
    ]);

    const { state, effects } = run([
      ...toTransforming,
      [{ type: "cleaned", id: ID, text: "Hello, world." }, 2300],
    ]);
    expect(state).toMatchObject({
      phase: "inserting",
      output: { text: "Hello, world.", html: null },
      insertedCleanup: null,
    });
    // Last transform is kept from the final text, after the dictionary pass, and before the write.
    expect(effects).toEqual([
      {
        type: "keepTransform",
        transformId: POLISH_ID,
        before: "hello um world",
        after: "Hello, world.",
      },
      remembered("hello um world", "Hello, world."),
      {
        type: "send",
        command: { type: "insert", id: ID, output: { text: "Hello, world.", html: null } },
      },
    ]);
  });

  test("cleanup returning empty for filler input ends empty and keeps the raw transcript", () => {
    const { state, effects, all } = run([
      ...toCleaning,
      [{ type: "cleaned", id: ID, text: "" }, 2300],
    ]);
    expect(state).toEqual({ phase: "done", id: ID, outcome: { kind: "empty" } });
    expect(types(all)).not.toContain("insert");
    expect(all).toContainEqual(remembered("hello um world", "hello um world"));
    expect(effects).toContainEqual({ type: "send", command: { type: "capture.cancel", id: ID } });
  });
});

describe("snippets", () => {
  const EMAIL = "name@example.com";
  const snippets: Snippet[] = [
    { id: "1", trigger: "my email", expansion: EMAIL, expansionHtml: null, enabled: true },
  ];
  const cleaned = (text: string) =>
    [{ type: "cleaned", id: ID, text }, 2300] as [SessionEvent, number];
  const cleaningSentence = [
    ...toTranscribing,
    transcript("send it to my email", STYLE, 2000, { ...NONE, snippets }),
  ];

  test("a dictation that is only a trigger types the expansion and skips cleanup", () => {
    const { state, effects } = run([
      ...toTranscribing,
      transcript("My email.", STYLE, 2000, { ...NONE, snippets }),
    ]);
    expect(state).toEqual({
      phase: "inserting",
      id: ID,
      raw: "My email.",
      output: { text: EMAIL, html: null },
      insertedCleanup: null,
      dictionaryFixes: 0,
      destination: null,
      copyToClipboard: false,
    });
    expect(effects).toEqual([
      remembered("My email.", EMAIL),
      { type: "send", command: { type: "insert", id: ID, output: { text: EMAIL, html: null } } },
    ]);
  });

  test("without cleanup a trigger inside the sentence is expanded", () => {
    const { effects } = run([
      ...toTranscribing,
      transcript("send it to my email", null, 2000, { ...NONE, snippets }),
    ]);
    expect(effects).toContainEqual({
      type: "send",
      command: { type: "insert", id: ID, output: { text: `send it to ${EMAIL}`, html: null } },
    });
  });

  test("cleanup gets the raw transcript while the expanded text is remembered", () => {
    const { state, effects } = run(cleaningSentence);
    expect(state.phase).toBe("cleaning");
    expect(effects).toEqual([
      remembered("send it to my email", `send it to ${EMAIL}`),
      { type: "cleanup", id: ID, raw: "send it to my email", work: STYLE },
    ]);
  });

  test("cleaned text is expanded", () => {
    const { effects } = run([...cleaningSentence, cleaned(" Send it to my email. ")]);
    expect(effects).toContainEqual({
      type: "send",
      command: { type: "insert", id: ID, output: { text: `Send it to ${EMAIL}.`, html: null } },
    });
  });

  test("a cleanup that dropped a trigger falls back to the expanded raw transcript", () => {
    const { state, effects } = run([...cleaningSentence, cleaned("Send it to me.")]);
    expect(state).toMatchObject({ phase: "inserting", insertedCleanup: null });
    expect(effects).toEqual([
      remembered("send it to my email", `send it to ${EMAIL}`),
      {
        type: "send",
        command: { type: "insert", id: ID, output: { text: `send it to ${EMAIL}`, html: null } },
      },
    ]);
  });

  test("a cleanup that turned a sentence into only the trigger types the expansion alone", () => {
    const { effects } = run([
      ...toTranscribing,
      transcript("um my email", STYLE, 2000, { ...NONE, snippets }),
      cleaned("My email."),
    ]);
    expect(effects).toContainEqual({
      type: "send",
      command: { type: "insert", id: ID, output: { text: EMAIL, html: null } },
    });
  });

  test("a cleanup that returned nothing for a transcript with a trigger inserts the expanded raw", () => {
    const { state, effects } = run([...cleaningSentence, cleaned("  ")]);
    expect(state.phase).toBe("inserting");
    expect(effects).toContainEqual({
      type: "send",
      command: { type: "insert", id: ID, output: { text: `send it to ${EMAIL}`, html: null } },
    });
  });

  test("a cleanup failure inserts the expanded raw transcript", () => {
    const { effects } = run([...cleaningSentence, [{ type: "cleanupFailed", id: ID }, 2300]]);
    expect(effects).toContainEqual({
      type: "send",
      command: { type: "insert", id: ID, output: { text: `send it to ${EMAIL}`, html: null } },
    });
  });

  test("an expansion is inserted untrimmed", () => {
    const signature: Snippet[] = [
      {
        id: "1",
        trigger: "sign off",
        expansion: "Best,\nAlex\n",
        expansionHtml: null,
        enabled: true,
      },
    ];
    const { effects } = run([
      ...toTranscribing,
      transcript("Sign off.", null, 2000, { ...NONE, snippets: signature }),
    ]);
    expect(effects).toContainEqual({
      type: "send",
      command: { type: "insert", id: ID, output: { text: "Best,\nAlex\n", html: null } },
    });
  });

  test("a formatted snippet is inserted with its HTML while history keeps the plain text", () => {
    const name: Snippet[] = [
      {
        id: "1",
        trigger: "my name",
        expansion: "Ana",
        expansionHtml: "<p><em>Ana</em></p>",
        enabled: true,
      },
    ];
    const whole = run([
      ...toTranscribing,
      transcript("My name.", STYLE, 2000, { ...NONE, snippets: name }),
    ]);
    expect(whole.state).toEqual({
      phase: "inserting",
      id: ID,
      raw: "My name.",
      output: { text: "Ana", html: "<em>Ana</em>" },
      insertedCleanup: null,
      dictionaryFixes: 0,
      destination: null,
      copyToClipboard: false,
    });
    expect(whole.effects).toEqual([
      remembered("My name.", "Ana"),
      {
        type: "send",
        command: { type: "insert", id: ID, output: { text: "Ana", html: "<em>Ana</em>" } },
      },
    ]);
    const cleanedSentence = run([
      ...toTranscribing,
      transcript("sign it my name", STYLE, 2000, { ...NONE, snippets: name }),
      cleaned("Sign it, my name."),
    ]);
    expect(cleanedSentence.effects).toEqual([
      remembered("sign it my name", "Sign it, Ana."),
      {
        type: "send",
        command: {
          type: "insert",
          id: ID,
          output: { text: "Sign it, Ana.", html: "Sign it, <em>Ana</em>." },
        },
      },
    ]);
  });
});

describe("dictionary", () => {
  const dictionary: DictionaryEntry[] = [
    { id: "1", phrase: "Wispr Flow", replacement: null },
    { id: "2", phrase: "Hadryś", replacement: null },
    { id: "3", phrase: "btw", replacement: "by the way" },
    { id: "4", phrase: "idk", replacement: "see my signature" },
  ];
  const snippets: Snippet[] = [
    {
      id: "s",
      trigger: "my signature",
      expansion: "wispr flow, btw, hadrys",
      expansionHtml: null,
      enabled: true,
    },
  ];
  const RAW = "btw ask hadrys about wispr flow";
  const FIXED = "by the way ask Hadryś about Wispr Flow";
  const cleaned = (text: string) =>
    [{ type: "cleaned", id: ID, text }, 2300] as [SessionEvent, number];
  const said = (text: string, cleanup: CleanupWork | null) =>
    transcript(text, cleanup, 2000, { dictionary, snippets });
  const cleaning = [...toTranscribing, said(RAW, STYLE)];

  test("without cleanup the transcript is fixed while the raw text is remembered untouched", () => {
    const { effects } = run([...toTranscribing, said(RAW, null)]);
    expect(effects).toEqual([
      remembered(RAW, FIXED),
      { type: "send", command: { type: "insert", id: ID, output: { text: FIXED, html: null } } },
    ]);
  });

  test("cleanup gets the raw transcript and its result is fixed", () => {
    const { effects: sent } = run(cleaning);
    expect(sent).toEqual([
      remembered(RAW, FIXED),
      { type: "cleanup", id: ID, raw: RAW, work: STYLE },
    ]);
    const { effects } = run([...cleaning, cleaned("BTW, ask hadrys about wispr  flow.")]);
    expect(effects).toEqual([
      remembered(RAW, "by the way, ask Hadryś about Wispr Flow."),
      {
        type: "send",
        command: {
          type: "insert",
          id: ID,
          output: { text: "by the way, ask Hadryś about Wispr Flow.", html: null },
        },
      },
    ]);
  });

  test("the inserting session counts the fixes of the branch it inserts", () => {
    expect(run([...toTranscribing, said(RAW, null)]).state).toMatchObject({
      insertedCleanup: null,
      dictionaryFixes: 3,
    });
    expect(run([...cleaning, cleaned("Ask Hadryś about Wispr Flow.")]).state).toMatchObject({
      insertedCleanup: "Ask Hadryś about Wispr Flow.",
      dictionaryFixes: 0,
    });
    expect(
      run([...toTranscribing, said("hadrys wants my signature", STYLE), cleaned("Hadryś left.")])
        .state,
    ).toMatchObject({
      output: { text: "Hadryś wants wispr flow, btw, hadrys" },
      insertedCleanup: null,
      dictionaryFixes: 1,
    });
  });

  test("a cleanup failure inserts the fixed raw transcript", () => {
    const { effects } = run([...cleaning, [{ type: "cleanupFailed", id: ID }, 2300]]);
    expect(effects).toEqual([
      remembered(RAW, FIXED),
      { type: "send", command: { type: "insert", id: ID, output: { text: FIXED, html: null } } },
    ]);
  });

  test("a cleanup that dropped a trigger falls back to the fixed, expanded raw transcript", () => {
    const { effects } = run([
      ...toTranscribing,
      said("hadrys wants my signature", STYLE),
      cleaned("Hadrys wants it."),
    ]);
    expect(effects).toContainEqual({
      type: "send",
      command: {
        type: "insert",
        id: ID,
        output: { text: "Hadryś wants wispr flow, btw, hadrys", html: null },
      },
    });
  });

  test("a dictation that is only a trigger types the expansion untouched", () => {
    const { effects } = run([...toTranscribing, said("My signature.", STYLE)]);
    expect(effects).toEqual([
      remembered("My signature.", "wispr flow, btw, hadrys"),
      {
        type: "send",
        command: {
          type: "insert",
          id: ID,
          output: { text: "wispr flow, btw, hadrys", html: null },
        },
      },
    ]);
  });

  test("a replacement whose text contains a trigger is typed as saved on every path", () => {
    const inserts = (events: [SessionEvent, number][]) =>
      run(events).all.filter(
        (effect) => effect.type === "send" && effect.command.type === "insert",
      );
    const typed = [
      {
        type: "send",
        command: { type: "insert", id: ID, output: { text: "see my signature", html: null } },
      },
    ];
    expect(inserts([...toTranscribing, said("idk", null)])).toEqual(typed);
    expect(inserts([...toTranscribing, said("idk", STYLE), cleaned("Idk.")])).toEqual([
      {
        type: "send",
        command: { type: "insert", id: ID, output: { text: "see my signature.", html: null } },
      },
    ]);
    expect(
      inserts([...toTranscribing, said("idk", STYLE), [{ type: "cleanupFailed", id: ID }, 2300]]),
    ).toEqual(typed);
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
      expect(effects).toEqual([
        dictated("hello world"),
        { type: "scheduleIdle", id: ID, ms: IDLE_AFTER_INSERTED_MS },
      ]);
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
      outcome: { kind: "notInserted", reason: "focusChanged", copied: false },
    });
    expect(all).toContainEqual(remembered("hello world", "hello world"));
    expect(effects).toEqual([
      dictated("hello world"),
      { type: "scheduleIdle", id: ID, ms: IDLE_AFTER_OTHER_MS },
    ]);
  });
});

describe("copy to clipboard", () => {
  const copying = (text: string, cleanup: CleanupWork | null, rewrites = NONE) =>
    transcript(text, cleanup, 2000, rewrites, true);

  test.each<[string, SessionEvent]>([
    ["inserted", { type: "insertResult", id: ID, method: "paste", reason: null }],
    ["not inserted", { type: "insertResult", id: ID, method: "none", reason: "focusChanged" }],
    ["timed out", { type: "timedOut", id: ID }],
    ["lost with the helper", { type: "helperExited" }],
  ])("copies the output once the insert is %s", (_, end) => {
    const { effects } = run([...toTranscribing, copying("hello world", null), [end, 2100]]);
    expect(effects).toContainEqual(copy("hello world"));
  });

  test("copies the expanded raw transcript when the helper exits mid-cleanup", () => {
    const snippets: Snippet[] = [
      { id: "1", trigger: "my email", expansion: "a@b.c", expansionHtml: null, enabled: true },
    ];
    const { effects } = run([
      ...toTranscribing,
      copying("send it to my email", STYLE, { ...NONE, snippets }),
      [{ type: "helperExited" }, 2300],
    ]);
    expect(effects).toContainEqual(copy("send it to a@b.c"));
    expect(effects).not.toContainEqual(
      expect.objectContaining({
        type: "send",
        command: expect.objectContaining({ type: "insert" }),
      }),
    );
  });

  test("copies nothing with the setting off", () => {
    const { state, all } = run([
      ...toInserting,
      [{ type: "insertResult", id: ID, method: "none", reason: "focusChanged" }, 2100],
    ]);
    expect(types(all)).not.toContain("copy");
    expect(state).toEqual({
      phase: "done",
      id: ID,
      outcome: { kind: "notInserted", reason: "focusChanged", copied: false },
    });
  });

  test("the outcome records that the text was copied", () => {
    const { state } = run([
      ...toTranscribing,
      copying("hello world", null),
      [{ type: "insertResult", id: ID, method: "none", reason: "focusChanged" }, 2100],
    ]);
    expect(state).toEqual({
      phase: "done",
      id: ID,
      outcome: { kind: "notInserted", reason: "focusChanged", copied: true },
    });
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
    expect(state).toEqual({ phase: "recording", id: ID, mode: "hold", pressedAt: 0 });
  });

  test("events for a stale session id are dropped", () => {
    const stale: SessionEvent[] = [
      { type: "captureStarted", id: "old" },
      { type: "captureFailed", id: "old", message: "x" },
      { type: "insertResult", id: "old", method: "paste", reason: null },
    ];
    for (const event of stale) {
      const { state, effects } = run([...toRecording, [event, 900]]);
      expect(state).toEqual({ phase: "recording", id: ID, mode: "hold", pressedAt: 0 });
      expect(effects).toEqual([]);
    }
  });

  test("a transcript for a session that is no longer current is remembered, never inserted", () => {
    const late: SessionEvent = {
      type: "transcript",
      id: "old",
      text: "late words",
      cleanup: STYLE,
      destination: null,
      copyToClipboard: false,
      rewrites: {
        dictionary: [{ id: "1", phrase: "late", replacement: "never typed" }],
        snippets: [
          {
            id: "1",
            trigger: "late words",
            expansion: "never typed",
            expansionHtml: null,
            enabled: true,
          },
        ],
      },
    };
    const remember = rememberedLate("late words", "old");
    expect(step(idle, late, 0)).toEqual({ state: idle, effects: [remember] });
    const { state, effects } = run([...toRecording, [late, 900]]);
    expect(state).toEqual({ phase: "recording", id: ID, mode: "hold", pressedAt: 0 });
    expect(effects).toEqual([remember]);
    expect(
      step(
        idle,
        {
          type: "transcript",
          id: "old",
          text: "  ",
          cleanup: null,
          rewrites: NONE,
          destination: null,
          copyToClipboard: false,
        },
        0,
      ),
    ).toEqual({
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

  test("helper exit mid-cleanup ends notInserted with the uncleaned text and stops the cleanup", () => {
    const { state, effects } = run([...toCleaning, [{ type: "helperExited" }, 2300]]);
    expect(state).toEqual({
      phase: "done",
      id: ID,
      outcome: { kind: "notInserted", reason: "failed", copied: false },
    });
    expect(effects).toEqual([
      { type: "cancelCleanup", id: ID },
      dictated("hello um world"),
      { type: "scheduleIdle", id: ID, ms: IDLE_AFTER_OTHER_MS },
    ]);
  });

  test("helper exit mid-insert ends notInserted and still counts the dictation", () => {
    const { state, effects } = run([...toInserting, [{ type: "helperExited" }, 2300]]);
    expect(state).toEqual({
      phase: "done",
      id: ID,
      outcome: { kind: "notInserted", reason: "failed", copied: false },
    });
    expect(effects).toEqual([
      dictated("hello world"),
      { type: "scheduleIdle", id: ID, ms: IDLE_AFTER_OTHER_MS },
    ]);
  });

  test("a transcription past the watchdog becomes overdue and keeps waiting", () => {
    const { state, effects } = run(toOverdue);
    expect(state).toEqual({ phase: "transcribing", id: ID, overdue: true });
    expect(effects).toEqual([]);
    expect(toPillState(state)).toEqual({ kind: "processing", overdue: true });
  });

  test("an overdue transcription that times out again ends failed and cancels the helper", () => {
    const { state, effects } = run(toGaveUp);
    expect(state).toEqual({
      phase: "done",
      id: ID,
      outcome: { kind: "failed", message: TRANSCRIBE_GAVE_UP_MESSAGE },
    });
    expect(effects).toEqual([
      { type: "send", command: { type: "capture.cancel", id: ID } },
      { type: "scheduleIdle", id: ID, ms: IDLE_AFTER_OTHER_MS },
    ]);
  });

  test("an overdue transcription still inserts, fails, or ends with the helper as usual", () => {
    expect(run([...toOverdue, transcript("late words", null, 50_000)]).state).toEqual({
      phase: "inserting",
      id: ID,
      raw: "late words",
      output: { text: "late words", html: null },
      insertedCleanup: null,
      dictionaryFixes: 0,
      destination: null,
      copyToClipboard: false,
    });
    expect(
      run([...toOverdue, [{ type: "transcriptFailed", id: ID, message: "asr broke" }, 50_000]])
        .state,
    ).toEqual({ phase: "done", id: ID, outcome: { kind: "failed", message: "asr broke" } });
    expect(run([...toOverdue, [{ type: "helperExited" }, 50_000]]).state).toEqual({
      phase: "done",
      id: ID,
      outcome: { kind: "failed", message: HELPER_EXITED_MESSAGE },
    });
  });

  test("the hotkey and Escape while overdue change nothing, so the busy helper is never asked", () => {
    const overdue = run(toOverdue).state;
    for (const event of [
      { type: "hotkeyDown", id: "s2", asr: "ready" },
      { type: "hotkeyUp" },
      { type: "hotkeyChord" },
      { type: "toggle", id: "s2", asr: "ready" },
      { type: "cancel" },
    ] satisfies SessionEvent[]) {
      expect(step(overdue, event, 50_000)).toEqual({ state: overdue, effects: [] });
    }
  });

  test("a transcript that lands after main gave up is remembered but not inserted", () => {
    const timedOut = run(toGaveUp).state;
    const { state, effects } = run([transcript("late words", STYLE, 41_000)], timedOut);
    expect(state).toBe(timedOut);
    expect(effects).toEqual([rememberedLate("late words", ID)]);
    expect(run([transcript("   ", STYLE, 41_000)], timedOut).effects).toEqual([]);
    expect(
      step(
        timedOut,
        {
          type: "transcript",
          id: "s2",
          text: "x",
          cleanup: null,
          rewrites: NONE,
          destination: null,
          copyToClipboard: false,
        },
        41_000,
      ),
    ).toEqual({ state: timedOut, effects: [rememberedLate("x", "s2")] });
  });

  test("an insert that never answers times out as notInserted with the text remembered", () => {
    const { state, all } = run([...toInserting, [{ type: "timedOut", id: ID }, 8000]]);
    expect(state).toEqual({
      phase: "done",
      id: ID,
      outcome: { kind: "notInserted", reason: "failed", copied: false },
    });
    expect(all).toContainEqual(remembered("hello world", "hello world"));
  });

  test("a timeout while recording or for another session changes nothing", () => {
    expect(run([...toRecording, [{ type: "timedOut", id: ID }, 500]]).state).toEqual({
      phase: "recording",
      id: ID,
      mode: "hold",
      pressedAt: 0,
    });
    expect(run([...toTranscribing, [{ type: "timedOut", id: "old" }, 500]]).state).toEqual({
      phase: "transcribing",
      id: ID,
      overdue: false,
    });
  });

  test("helper exit while idle or done changes nothing", () => {
    expect(step(idle, { type: "helperExited" }, 0)).toEqual({ state: idle, effects: [] });
    const done = run([...toTranscribing, transcript("", STYLE)]).state;
    expect(step(done, { type: "helperExited" }, 0)).toEqual({ state: done, effects: [] });
  });
});

describe("pill projection", () => {
  test("only an active capture shows as listening", () => {
    expect(toPillState(idle)).toEqual({ kind: "idle" });
    expect(toPillState(run([down(0)]).state)).toEqual({ kind: "idle" });
    expect(toPillState(run(toRecording).state)).toEqual({ kind: "listening" });
    expect(toPillState(run(toTranscribing).state)).toEqual({ kind: "processing", overdue: false });
    expect(toPillState(run(toCleaning).state)).toEqual({ kind: "processing", overdue: false });
    expect(toPillState(run(toInserting).state)).toEqual({ kind: "processing", overdue: false });
    expect(toPillState(run([down(0, "missing")]).state)).toEqual({
      kind: "done",
      outcome: { kind: "failed", message: ASR_MISSING_MESSAGE },
    });
  });
});

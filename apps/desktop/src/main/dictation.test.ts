import type { CleanupStyle } from "@voice/cleanup";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { ModelStatus } from "../shared/api.ts";
import { dictationLanguages, type DictationLanguage } from "../shared/dictation-language.ts";
import {
  CLEANUP_BASE_MS,
  CLEANUP_MAX_MS,
  CLEANUP_PER_WORD_MS,
  INSERT_TIMEOUT_MS,
  START_TIMEOUT_MS,
  TRANSCRIBE_TIMEOUT_MS,
  TRANSCRIBE_WHILE_LOADING_TIMEOUT_MS,
  cleanupBudgetMs,
  createDictation,
  type SessionReport,
} from "./dictation.ts";
import type { HelperCommand } from "./protocol.ts";
import {
  ASR_MISSING_MESSAGE,
  IDLE_AFTER_INSERTED_MS,
  IDLE_AFTER_OTHER_MS,
  idle,
} from "./session.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { createStore, toSnapshot } from "./store.ts";

type Options = {
  dictationLanguage?: DictationLanguage;
  asrModel?: ModelStatus;
  cleanupLoaded?: boolean;
  cleanupEnabled?: boolean;
  styling?: CleanupStyle["styling"];
  cleanFails?: boolean;
  cleanHangs?: boolean;
};

function harness(opts: Options = {}) {
  const store = createStore({
    updates: {
      version: "0.0.1",
      installedChannel: "stable",
      channel: "stable",
      status: { kind: "disabled", reason: "Test" },
    },
    session: idle,
    permissions: { microphone: "granted", accessibility: "granted" },
    models: {
      asr: opts.asrModel ?? { state: "ready" },
      cleanup: { state: "ready" },
    },
    settings: {
      ...DEFAULT_SETTINGS,
      dictationLanguage: opts.dictationLanguage ?? DEFAULT_SETTINGS.dictationLanguage,
      cleanup: {
        enabled: opts.cleanupEnabled ?? true,
        styling: opts.styling ?? DEFAULT_SETTINGS.cleanup.styling,
      },
    },
    microphones: { kind: "loading" },
    microphoneTest: { kind: "off" },
    last: null,
  });
  const commands: HelperCommand[] = [];
  const cleans: string[] = [];
  const styles: CleanupStyle[] = [];
  const signals: AbortSignal[] = [];
  const hung: ((text: string) => void)[] = [];
  const levels: number[] = [];
  const logs: string[] = [];
  const phases: string[] = [];
  const reports: SessionReport[] = [];
  store.subscribe((state) => phases.push(toSnapshot(state).session.kind));
  const dictation = createDictation({
    store,
    send: (command) => commands.push(command),
    cleanup: {
      loaded: () => opts.cleanupLoaded ?? true,
      clean: async (raw, style, signal) => {
        cleans.push(raw);
        styles.push(style);
        signals.push(signal);
        if (opts.cleanFails) throw new Error("model crashed");
        if (opts.cleanHangs) return new Promise<string>((resolve) => hung.push(resolve));
        return `${raw}.`;
      },
    },
    onLevel: (level) => levels.push(level),
    log: (message) => logs.push(message),
    onSessionDone: (report) => reports.push(report),
  });
  const id = () => {
    const session = store.state.session;
    if (session.phase === "idle") throw new Error("no session");
    return session.id;
  };
  return {
    store,
    commands,
    cleans,
    styles,
    signals,
    hung,
    levels,
    logs,
    phases,
    reports,
    dictation,
    id,
  };
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("createDictation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test.each(dictationLanguages)("passes $label to speech recognition", ({ value }) => {
    const h = harness({ dictationLanguage: value });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    expect(h.commands).toEqual([
      {
        type: "capture.start",
        id: h.id(),
        muteWhileDictating: false,
        language: value,
        microphone: null,
      },
    ]);
  });

  test("snapshots the microphone per session and applies a changed choice next time", () => {
    const h = harness();
    const microphone = { uid: "usb", name: "USB Microphone" };
    h.store.update((state) => ({ ...state, settings: { ...state.settings, microphone } }));
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    expect(h.commands.at(-1)).toMatchObject({ type: "capture.start", microphone });
    h.store.update((state) => ({ ...state, settings: { ...state.settings, microphone: null } }));
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]).toMatchObject({ microphone });
    h.dictation.onHelperEvent({ type: "hotkey", action: "cancel" });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    expect(h.commands.at(-1)).toMatchObject({ type: "capture.start", microphone: null });
  });

  test("publishes live catalog changes without changing the saved microphone or starting capture", () => {
    const h = harness();
    const microphone = { uid: "usb", name: "USB Microphone" };
    h.store.update((state) => ({ ...state, settings: { ...state.settings, microphone } }));
    h.dictation.onHelperEvent({ type: "microphones.changed", devices: [], defaultUid: null });
    expect(h.store.state.microphones).toEqual({ kind: "ready", devices: [], defaultUid: null });
    expect(h.store.state.settings.microphone).toEqual(microphone);
    h.dictation.onHelperEvent({
      type: "microphones.changed",
      devices: [microphone],
      defaultUid: "usb",
    });
    expect(h.store.state.microphones).toEqual({
      kind: "ready",
      devices: [microphone],
      defaultUid: "usb",
    });
    h.dictation.onHelperEvent({ type: "microphones.unavailable", message: "Disconnected" });
    expect(h.store.state.microphones).toEqual({ kind: "unavailable", message: "Disconnected" });
    expect(h.commands).toEqual([]);
  });

  test("snapshots the mute preference once per capture start", () => {
    const h = harness();
    h.store.update((state) => ({
      ...state,
      settings: { ...state.settings, muteWhileDictating: true },
    }));
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    const first = h.id();
    expect(h.commands).toEqual([
      {
        type: "capture.start",
        id: first,
        language: "en",
        muteWhileDictating: true,
        microphone: null,
      },
    ]);
    h.store.update((state) => ({
      ...state,
      settings: { ...state.settings, muteWhileDictating: false },
    }));
    expect(h.commands).toHaveLength(1);
    h.dictation.onHelperEvent({ type: "hotkey", action: "cancel" });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    expect(h.commands.at(-1)).toEqual({
      type: "capture.start",
      microphone: null,
      id: h.id(),
      language: "en",
      muteWhileDictating: false,
    });
  });

  test("drives a full session from hotkey down to inserted and back to idle", async () => {
    const h = harness();
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    const id = h.id();
    expect(h.commands).toEqual([
      { type: "capture.start", id, language: "en", muteWhileDictating: false, microphone: null },
    ]);
    h.dictation.onHelperEvent({ type: "capture.started", id, startMs: 40 });
    h.dictation.onHelperEvent({ type: "capture.level", id, level: 0.4 });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up" });
    expect(h.commands.at(-1)).toEqual({ type: "capture.stop", id });
    h.dictation.onHelperEvent({
      type: "transcript",
      id,
      text: "hello world",
      audioMs: 800,
      asrMs: 120,
    });
    await flush();
    expect(h.cleans).toEqual(["hello world"]);
    expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: "hello world." });
    expect(h.store.state.last).toEqual({ raw: "hello world", text: "hello world." });
    h.dictation.onHelperEvent({ type: "insert.result", id, method: "accessibility", reason: null });
    expect(h.store.state.session).toEqual({
      phase: "done",
      id,
      outcome: { kind: "inserted", method: "accessibility" },
    });
    vi.advanceTimersByTime(IDLE_AFTER_INSERTED_MS);
    expect(h.store.state.session).toEqual(idle);
    const distinct = h.phases.filter((kind, i) => kind !== h.phases[i - 1]);
    expect(distinct).toEqual(["idle", "listening", "processing", "done", "idle"]);
    expect(h.levels).toEqual([0.4]);
    const timing = h.logs.find((line) => line.startsWith("session "));
    expect(timing).toMatch(
      /outcome=inserted startMs=40 audioMs=800 asrMs=120 cleanupMs=\d+ insertMs=\d+ releaseToInsertMs=\d+/,
    );
    expect(timing).not.toContain("hello");
  });

  test("reports a finished session once, with the logged timings and no text or id", async () => {
    const h = harness({ dictationLanguage: "en" });
    const pressedAt = Date.now();
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    const id = h.id();
    h.dictation.onHelperEvent({ type: "capture.started", id, startMs: 40 });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up" });
    h.dictation.onHelperEvent({
      type: "transcript",
      id,
      text: "call Anna",
      audioMs: 800,
      asrMs: 120,
    });
    await flush();
    vi.advanceTimersByTime(30);
    h.dictation.onHelperEvent({ type: "insert.result", id, method: "paste", reason: null });
    vi.advanceTimersByTime(IDLE_AFTER_INSERTED_MS);
    expect(h.reports).toEqual([
      {
        outcome: { kind: "inserted", method: "paste" },
        finishedAt: pressedAt + 830,
        capture: {
          language: "en",
          pressedAt,
          timings: {
            startMs: 40,
            audioMs: 800,
            asrMs: 120,
            cleanupMs: 0,
            insertMs: 30,
            releaseToInsertMs: 30,
          },
        },
      },
    ]);
    expect(h.logs).toContain(
      `session ${id.slice(0, 8)} outcome=inserted startMs=40 audioMs=800 asrMs=120 cleanupMs=0 insertMs=30 releaseToInsertMs=30`,
    );
    const json = JSON.stringify(h.reports);
    expect(json).not.toContain("Anna");
    expect(json).not.toContain(id.slice(0, 8));
  });

  test("reports a failed session once, with its language", () => {
    const h = harness({ dictationLanguage: "pl" });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    const id = h.id();
    h.dictation.onHelperEvent({ type: "capture.started", id, startMs: 25 });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up" });
    h.dictation.onHelperEvent({ type: "transcript.failed", id, message: "decoder broke" });
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({ capture: { language: "pl", timings: { startMs: 25 } } });
    expect(h.reports[0]?.outcome.kind).toBe("failed");
    expect(h.reports[0]?.capture?.timings.releaseToInsertMs).toBeUndefined();
  });

  test("reports a session that ended before capture without the previous session's data", () => {
    const h = harness({ dictationLanguage: "pl" });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    const first = h.id();
    h.dictation.onHelperEvent({ type: "capture.started", id: first, startMs: 25 });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up" });
    h.dictation.onHelperEvent({ type: "transcript.failed", id: first, message: "decoder broke" });
    vi.advanceTimersByTime(IDLE_AFTER_OTHER_MS);
    h.store.update((s) => ({ ...s, models: { ...s.models, asr: { state: "missing" } } }));
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    expect(h.reports).toHaveLength(2);
    expect(h.reports[1]).toEqual({
      outcome: { kind: "failed", message: ASR_MISSING_MESSAGE },
      finishedAt: Date.now(),
      capture: null,
    });
  });

  test("cleans with the user's styling and no other settings", async () => {
    const h = harness({ styling: "casual" });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    const id = h.id();
    h.dictation.onHelperEvent({ type: "capture.started", id, startMs: 40 });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up" });
    h.dictation.onHelperEvent({ type: "transcript", id, text: "hey", audioMs: 800, asrMs: 120 });
    await flush();
    expect(h.styles).toStrictEqual([{ styling: "casual" }]);
  });

  test.each([
    ["cleanup is disabled", { cleanupEnabled: false }],
    ["the cleanup model is not loaded", { cleanupLoaded: false }],
  ])("inserts the raw transcript when %s", async (_name, opts) => {
    const h = harness(opts);
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    const id = h.id();
    h.dictation.onHelperEvent({ type: "capture.started", id, startMs: 40 });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up" });
    h.dictation.onHelperEvent({
      type: "transcript",
      id,
      text: "raw words",
      audioMs: 800,
      asrMs: 100,
    });
    await flush();
    expect(h.cleans).toEqual([]);
    expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: "raw words" });
  });

  test.each(dictationLanguages.filter(({ value }) => value !== "en"))(
    "$label preserves the original Unicode transcript through insertion",
    async ({ value }) => {
      const h = harness({ dictationLanguage: value });
      const raw = "Zażółć gęślą jaźń.\nПривіт, світе! Café à 15:30.";
      h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
      const id = h.id();
      expect(h.commands).toEqual([
        { type: "capture.start", id, language: value, muteWhileDictating: false, microphone: null },
      ]);
      h.dictation.onHelperEvent({ type: "capture.started", id, startMs: 40 });
      vi.advanceTimersByTime(800);
      h.dictation.onHelperEvent({ type: "hotkey", action: "up" });
      h.dictation.onHelperEvent({ type: "transcript", id, text: raw, audioMs: 800, asrMs: 100 });
      await flush();
      expect(h.cleans).toEqual([]);
      expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: raw });
      expect(h.store.state.last).toEqual({ raw, text: raw });
      h.dictation.onHelperEvent({
        type: "insert.result",
        id,
        method: "accessibility",
        reason: null,
      });
      expect(toSnapshot(h.store.state).session).toEqual({
        kind: "done",
        outcome: { kind: "inserted", method: "accessibility" },
      });
    },
  );

  test.each([
    { before: "en", after: "pl", firstCleaned: true },
    { before: "pl", after: "en", firstCleaned: false },
    { before: "en", after: "auto", firstCleaned: true },
    { before: "auto", after: "en", firstCleaned: false },
  ] satisfies { before: DictationLanguage; after: DictationLanguage; firstCleaned: boolean }[])(
    "changing $before to $after during recording applies to the next session",
    async ({ before, after, firstCleaned }) => {
      const h = harness({ dictationLanguage: before });
      h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
      const first = h.id();
      expect(h.commands.at(-1)).toMatchObject({
        type: "capture.start",
        language: before,
        microphone: null,
      });
      h.dictation.onHelperEvent({ type: "capture.started", id: first, startMs: 40 });
      h.store.update((s) => ({ ...s, settings: { ...s.settings, dictationLanguage: after } }));
      vi.advanceTimersByTime(800);
      h.dictation.onHelperEvent({ type: "hotkey", action: "up" });
      h.dictation.onHelperEvent({
        type: "transcript",
        id: first,
        text: "first",
        audioMs: 800,
        asrMs: 100,
      });
      await flush();
      expect(h.commands.at(-1)).toEqual({
        type: "insert",
        id: first,
        text: firstCleaned ? "first." : "first",
      });
      h.dictation.onHelperEvent({
        type: "insert.result",
        id: first,
        method: "paste",
        reason: null,
      });
      h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
      const second = h.id();
      expect(h.commands.at(-1)).toMatchObject({
        type: "capture.start",
        language: after,
        microphone: null,
      });
      h.dictation.onHelperEvent({ type: "capture.started", id: second, startMs: 40 });
      vi.advanceTimersByTime(800);
      h.dictation.onHelperEvent({ type: "hotkey", action: "up" });
      h.dictation.onHelperEvent({
        type: "transcript",
        id: second,
        text: "second",
        audioMs: 800,
        asrMs: 100,
      });
      await flush();
      expect(h.commands.at(-1)).toEqual({
        type: "insert",
        id: second,
        text: firstCleaned ? "second" : "second.",
      });
      expect(h.cleans).toEqual([firstCleaned ? "first" : "second"]);
    },
  );

  test("a transcript during the cleanup warm-up is cleaned, not inserted raw", async () => {
    const h = harness();
    h.store.update((s) => ({ ...s, models: { ...s.models, cleanup: { state: "loading" } } }));
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    const id = h.id();
    h.dictation.onHelperEvent({ type: "capture.started", id, startMs: 40 });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up" });
    h.dictation.onHelperEvent({ type: "transcript", id, text: "hi", audioMs: 800, asrMs: 100 });
    await flush();
    expect(h.cleans).toEqual(["hi"]);
    expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: "hi." });
  });

  test("a cleanup crash inserts the raw transcript", async () => {
    const h = harness({ cleanFails: true });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    const id = h.id();
    h.dictation.onHelperEvent({ type: "capture.started", id, startMs: 40 });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up" });
    h.dictation.onHelperEvent({
      type: "transcript",
      id,
      text: "keep me",
      audioMs: 800,
      asrMs: 100,
    });
    await flush();
    expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: "keep me" });
    expect(h.store.state.last).toEqual({ raw: "keep me", text: "keep me" });
  });

  test("a cleanup that overruns its budget is aborted, inserts the raw text, and ignores the late result", async () => {
    const h = harness({ cleanHangs: true });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    const id = h.id();
    h.dictation.onHelperEvent({ type: "capture.started", id, startMs: 40 });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up" });
    h.dictation.onHelperEvent({
      type: "transcript",
      id,
      text: "one two three",
      audioMs: 800,
      asrMs: 100,
    });
    await flush();
    expect(h.cleans).toEqual(["one two three"]);
    await vi.advanceTimersByTimeAsync(cleanupBudgetMs("one two three") - 1);
    expect(h.commands.at(-1)).toEqual({ type: "capture.stop", id });
    expect(h.signals[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.signals[0]!.aborted).toBe(true);
    expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: "one two three" });
    expect(h.logs).toContainEqual(expect.stringContaining("cleanup timed out"));
    h.hung[0]!("late polished text");
    await flush();
    expect(h.commands.filter((c) => c.type === "insert")).toEqual([
      { type: "insert", id, text: "one two three" },
    ]);
    expect(h.store.state.last).toEqual({ raw: "one two three", text: "one two three" });
  });

  test("cleanup budget grows with the input and is capped", () => {
    expect(cleanupBudgetMs("")).toBe(CLEANUP_BASE_MS);
    expect(cleanupBudgetMs("a b c")).toBe(CLEANUP_BASE_MS + 3 * CLEANUP_PER_WORD_MS);
    expect(cleanupBudgetMs("w ".repeat(1000))).toBe(CLEANUP_MAX_MS);
  });

  test("the next session is cleaned even when the earlier aborted cleanup has not settled yet", async () => {
    const h = harness({ cleanHangs: true });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    const first = h.id();
    h.dictation.onHelperEvent({ type: "capture.started", id: first, startMs: 40 });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up" });
    h.dictation.onHelperEvent({
      type: "transcript",
      id: first,
      text: "one",
      audioMs: 800,
      asrMs: 100,
    });
    await vi.advanceTimersByTimeAsync(cleanupBudgetMs("one"));
    h.dictation.onHelperEvent({ type: "insert.result", id: first, method: "paste", reason: null });
    await vi.advanceTimersByTimeAsync(IDLE_AFTER_INSERTED_MS);

    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    const second = h.id();
    h.dictation.onHelperEvent({ type: "capture.started", id: second, startMs: 40 });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up" });
    h.dictation.onHelperEvent({
      type: "transcript",
      id: second,
      text: "two",
      audioMs: 800,
      asrMs: 100,
    });
    await flush();
    expect(h.cleans).toEqual(["one", "two"]);
    expect(h.signals.map((s) => s.aborted)).toEqual([true, false]);

    h.hung[0]!("ONE");
    h.hung[1]!("Two.");
    await flush();
    expect(h.commands.filter((c) => c.type === "insert").map((c) => c.text)).toEqual([
      "one",
      "Two.",
    ]);
  });

  test("an insert the helper never answers ends notInserted after the watchdog", () => {
    const h = harness({ cleanupEnabled: false });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    const id = h.id();
    h.dictation.onHelperEvent({ type: "capture.started", id, startMs: 40 });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up" });
    h.dictation.onHelperEvent({ type: "transcript", id, text: "stuck", audioMs: 800, asrMs: 100 });
    vi.advanceTimersByTime(INSERT_TIMEOUT_MS - 1);
    expect(h.store.state.session.phase).toBe("inserting");
    vi.advanceTimersByTime(1);
    expect(h.store.state.session).toEqual({
      phase: "done",
      id,
      outcome: { kind: "notInserted", reason: "failed" },
    });
    expect(h.store.state.last).toEqual({ raw: "stuck", text: "stuck" });
  });

  test("a transcription the helper never answers ends failed, cancels the capture, and still keeps a late transcript", () => {
    const h = harness();
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    const id = h.id();
    h.dictation.onHelperEvent({ type: "capture.started", id, startMs: 40 });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up" });
    vi.advanceTimersByTime(TRANSCRIBE_TIMEOUT_MS);
    expect(h.store.state.session).toMatchObject({ phase: "done", id, outcome: { kind: "failed" } });
    expect(h.commands.at(-1)).toEqual({ type: "capture.cancel", id });
    h.dictation.onHelperEvent({ type: "transcript", id, text: "late", audioMs: 800, asrMs: 100 });
    expect(h.store.state.last).toEqual({ raw: "late", text: "late" });
    expect(h.commands.filter((c) => c.type === "insert")).toEqual([]);
  });

  test("a capture the helper never starts ends failed and cancels it after the watchdog", () => {
    const h = harness();
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    const id = h.id();
    vi.advanceTimersByTime(START_TIMEOUT_MS - 1);
    expect(h.store.state.session.phase).toBe("starting");
    vi.advanceTimersByTime(1);
    expect(h.store.state.session).toMatchObject({ phase: "done", id, outcome: { kind: "failed" } });
    expect(h.commands).toEqual([
      { type: "capture.start", id, language: "en", muteWhileDictating: false, microphone: null },
      { type: "capture.cancel", id },
    ]);
  });

  test("the transcription watchdog waits longer while the speech model is still loading", () => {
    const h = harness({ asrModel: { state: "loading" } });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    const id = h.id();
    h.dictation.onHelperEvent({ type: "capture.started", id, startMs: 40 });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up" });
    vi.advanceTimersByTime(TRANSCRIBE_TIMEOUT_MS);
    expect(h.store.state.session).toEqual({ phase: "transcribing", id });
    vi.advanceTimersByTime(TRANSCRIBE_WHILE_LOADING_TIMEOUT_MS - TRANSCRIBE_TIMEOUT_MS);
    expect(h.store.state.session).toMatchObject({ phase: "done", id, outcome: { kind: "failed" } });
    expect(h.commands.at(-1)).toEqual({ type: "capture.cancel", id });
  });

  test("hotkey down while the speech model downloads sends nothing and names the download", () => {
    const h = harness({ asrModel: { state: "downloading", progress: 0.3 } });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    expect(h.commands).toEqual([]);
    expect(toSnapshot(h.store.state).session).toEqual({
      kind: "done",
      outcome: { kind: "failed", message: "The speech model is still downloading" },
    });
  });

  test("hotkey down with the ASR model missing sends nothing to the helper", () => {
    const h = harness();
    h.dictation.onHelperEvent({ type: "asr.status", state: "missing", message: null });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    expect(h.commands).toEqual([]);
    expect(toSnapshot(h.store.state).session).toEqual({
      kind: "done",
      outcome: { kind: "failed", message: "Set up the speech model in Voice first" },
    });
  });

  test("a new session cancels the pending idle timer of the previous one", () => {
    const h = harness({ cleanupEnabled: false });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    const first = h.id();
    h.dictation.onHelperEvent({ type: "capture.started", id: first, startMs: 40 });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up" });
    h.dictation.onHelperEvent({
      type: "transcript",
      id: first,
      text: "one",
      audioMs: 800,
      asrMs: 100,
    });
    h.dictation.onHelperEvent({ type: "insert.result", id: first, method: "paste", reason: null });
    vi.advanceTimersByTime(IDLE_AFTER_INSERTED_MS - 100);
    h.dictation.onHelperEvent({ type: "hotkey", action: "down" });
    const second = h.id();
    expect(second).not.toBe(first);
    vi.advanceTimersByTime(500);
    expect(h.store.state.session).toMatchObject({ phase: "starting", id: second });
  });

  test("helper status events update permissions and the ASR model", () => {
    const h = harness();
    h.dictation.onHelperEvent({
      type: "permissions",
      microphone: "denied",
      accessibility: "granted",
    });
    h.dictation.onHelperEvent({ type: "asr.status", state: "failed", message: "corrupt" });
    expect(h.store.state.permissions).toEqual({ microphone: "denied", accessibility: "granted" });
    expect(h.store.state.models.asr).toEqual({ state: "failed", message: "corrupt" });
  });
});

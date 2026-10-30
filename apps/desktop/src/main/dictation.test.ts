import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import { type CleanResult, type CleanupStyle } from "@voice/cleanup";
import * as Option from "effect/Option";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { DEFAULT_SETTINGS, type ModelStatus } from "../shared/api.ts";
import { dictationLanguages, type DictationLanguage } from "../shared/dictation-language.ts";
import type { DictionaryEntry } from "../shared/dictionary.ts";
import type { Output } from "../shared/rewrite.ts";
import type { Snippet } from "../shared/snippets.ts";
import {
  BUILT_IN_TRANSFORMS,
  POLISH_ID,
  type LastTransform,
  type Transform,
  type TransformId,
} from "../shared/transforms.ts";
import {
  DEFAULT_STYLES,
  parseAssignments,
  type Assignment,
  type CategoryStyles,
  type Target,
} from "../shared/style.ts";
import type { DiagnosticLog } from "./diagnostics-scrub.ts";
import {
  AUTO_APPLY_BUDGET,
  CLEANUP_BUDGET,
  CLEANUP_GRACE_MS,
  START_TIMEOUT_MS,
  TRANSCRIBE_OVERDUE_MIN_MS,
  TRANSCRIBE_TIMEOUT_MS,
  TRANSCRIBE_WHILE_LOADING_TIMEOUT_MS,
  autoApplyBudgetMs,
  cleanupBudgetMs,
  createDictation,
  type Dictated,
  type SessionReport,
} from "./dictation.ts";
import { whenIdle } from "./activity.ts";
import { createHistory } from "./history.ts";
import { decodeTarget, type HelperCommand, type HelperEvent } from "./protocol.ts";
import {
  ASR_MISSING_MESSAGE,
  IDLE_AFTER_INSERTED_MS,
  IDLE_AFTER_OTHER_MS,
  INSERT_TIMEOUT_MS,
  TRANSCRIBE_GAVE_UP_MESSAGE,
  idle,
  type SessionEvent,
} from "./session.ts";
import { idleRun } from "./transform-run.ts";
import type { TransformRequest, TransformResult } from "./transform-model.ts";
import { createStore, toSnapshot } from "./store.ts";

type Options = {
  dictationLanguage?: DictationLanguage;
  asrModel?: ModelStatus;
  cleanupLoaded?: boolean;
  cleanupEnabled?: boolean;
  styles?: Partial<CategoryStyles>;
  assignments?: readonly Assignment[];
  cleanFails?: "rejects" | "throws";
  cleanHangs?: boolean;
  cleanPartial?: boolean;
  copyToClipboard?: boolean;
  snippets?: readonly Snippet[];
  dictionary?: readonly DictionaryEntry[];
  autoApply?: TransformId;
  transforms?: readonly Transform[];
  transformsEnabled?: boolean;
  transformOnDisk?: boolean;
  transformResult?: TransformResult | "rejects" | "hangs";
};

const formattedName: Snippet = {
  id: "1",
  trigger: "my name",
  expansion: "Ana",
  expansionHtml: "<p><em>Ana</em></p>",
  enabled: true,
};

const transcriptEvent = (id: string, text: string, target: Target | null): HelperEvent => ({
  type: "transcript",
  id,
  text,
  audioMs: 800,
  asrMs: 100,
  speechMs: 600,
  relayMs: null,
  target,
});

function harness(opts: Options = {}) {
  const store = createStore({
    updates: {
      version: "0.0.1",
      installedChannel: "stable",
      channel: "stable",
      status: { kind: "disabled", reason: "Test" },
    },
    session: idle,
    transform: idleRun,
    permissions: { microphone: "granted", accessibility: "granted" },
    loginItem: "off",
    models: {
      asr: opts.asrModel ?? { state: "ready" },
      cleanup: { state: "ready" },
      transform: { state: "missing" },
    },
    settings: {
      ...DEFAULT_SETTINGS,
      dictationLanguage: opts.dictationLanguage ?? DEFAULT_SETTINGS.dictationLanguage,
      copyToClipboard: opts.copyToClipboard ?? DEFAULT_SETTINGS.copyToClipboard,
      snippets: opts.snippets ?? DEFAULT_SETTINGS.snippets,
      dictionary: opts.dictionary ?? DEFAULT_SETTINGS.dictionary,
      transforms: {
        ...DEFAULT_SETTINGS.transforms,
        enabled: opts.transformsEnabled ?? opts.autoApply !== undefined,
        items: opts.transforms ?? DEFAULT_SETTINGS.transforms.items,
        autoApply: opts.autoApply ?? null,
      },
      cleanup: {
        enabled: opts.cleanupEnabled ?? true,
        styles: { ...DEFAULT_STYLES, ...opts.styles },
        assignments: opts.assignments ?? [],
      },
    },
    microphones: { kind: "loading" },
    microphoneTest: { kind: "off" },
    account: { kind: "signedOut" },
  });
  const history = createHistory({
    file: NodePath.join(tmpdir(), "voice-dictation-test", "history.json"),
    log: () => {},
    onChange: () => {},
  });
  const commands: HelperCommand[] = [];
  let transcribing: string | null = null;
  const cleans: string[] = [];
  const gpu: ("busy" | "idle")[] = [];
  const styles: CleanupStyle[] = [];
  const signals: AbortSignal[] = [];
  const budgets: number[] = [];
  const hung: ((result: CleanResult) => void)[] = [];
  const levels: number[] = [];
  const logs: string[] = [];
  const entries: DiagnosticLog[] = [];
  const phases: string[] = [];
  const reports: SessionReport[] = [];
  const dictated: Dictated[] = [];
  const copies: Output[] = [];
  const transformRuns: TransformRequest[] = [];
  let warms = 0;
  const lastTransforms: Omit<LastTransform, "finishedAt">[] = [];
  store.subscribe((state) => phases.push(toSnapshot(state).session.kind));
  const dictation = createDictation({
    store,
    send: (command) => {
      commands.push(command);
      if (command.type === "capture.stop") transcribing = command.id;
      if (command.type === "capture.cancel" && transcribing === command.id) transcribing = null;
      if (command.type === "capture.start" && transcribing !== null) {
        onHelperEvent({
          type: "capture.failed",
          id: command.id,
          message: "capture is busy with another session",
        });
      }
    },
    cleanup: {
      loaded: () => opts.cleanupLoaded ?? true,
      keepGpuBusy: () => gpu.push("busy"),
      letGpuIdle: () => gpu.push("idle"),
      clean: (raw, style, { budgetMs, signal }) => {
        cleans.push(raw);
        styles.push(style);
        signals.push(signal);
        budgets.push(budgetMs);
        if (opts.cleanFails === "throws") throw new Error("model crashed");
        if (opts.cleanFails === "rejects") return Promise.reject(new Error("model crashed"));
        if (opts.cleanHangs) return new Promise<CleanResult>((resolve) => hung.push(resolve));
        const chunks = opts.cleanPartial ? 3 : 1;
        return Promise.resolve({ text: `${raw}.`, chunks, cleaned: 1, queueMs: 2, generateMs: 5 });
      },
    },
    transform: {
      model: {
        onDisk: () => opts.transformOnDisk ?? true,
        warm: () => {
          warms += 1;
        },
        run: (request) => {
          transformRuns.push(request);
          const result = opts.transformResult ?? { ok: true, text: `Polished: ${request.text}` };
          if (result === "rejects") return Promise.reject(new Error("The transform model stopped"));
          if (result === "hangs") {
            return new Promise((_, reject) =>
              request.signal.addEventListener("abort", () => reject(request.signal.reason)),
            );
          }
          return Promise.resolve(result);
        },
      },
      remember: (value) => lastTransforms.push(value),
    },
    onLevel: (level) => levels.push(level),
    log: (message, entry) => {
      logs.push(message);
      if (entry) entries.push(entry);
    },
    onSessionDone: (report) => reports.push(report),
    onDictated: (session) => dictated.push(session),
    history,
    copy: (output) => copies.push(output),
  });
  const id = () => {
    const session = store.state.session;
    if (session.phase === "idle") throw new Error("no session");
    return session.id;
  };
  function onHelperEvent(event: HelperEvent) {
    if (event.type === "transcript" || event.type === "transcript.failed") {
      if (transcribing === event.id) transcribing = null;
    }
    dictation.onHelperEvent(event);
  }
  function dispatch(event: SessionEvent) {
    if (event.type === "helperExited") transcribing = null;
    dictation.dispatch(event);
  }
  const helper = {
    transcript(sessionId: string, text: string) {
      if (transcribing !== sessionId) return;
      onHelperEvent(transcriptEvent(sessionId, text, null));
    },
  };
  return {
    store,
    helper,
    latest: () => history.entries()[0] ?? null,
    recorded: () => history.entries(),
    commands,
    cleans,
    gpu,
    styles,
    signals,
    budgets,
    hung,
    levels,
    logs,
    entries,
    phases,
    reports,
    dictated,
    copies,
    transformRuns,
    warms: () => warms,
    lastTransforms,
    dictation: { dispatch, onHelperEvent },
    id,
  };
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

const target = (bundleId: string, host: string | null = null) =>
  Option.getOrThrow(decodeTarget({ bundleId, host }));
const mailApp = target("com.apple.mail");
const chromeAt = (host: string) => target("com.google.Chrome", host);

async function dictate(h: ReturnType<typeof harness>, text: string, to: Target | null = null) {
  h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
  const id = h.id();
  h.dictation.onHelperEvent({
    type: "capture.started",
    id,
    startMs: 40,
    relayMs: null,
    asrState: null,
  });
  vi.advanceTimersByTime(800);
  h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
  h.dictation.onHelperEvent(transcriptEvent(id, text, to));
  await flush();
  return id;
}

function release(h: ReturnType<typeof harness>, holdMs: number) {
  h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
  const id = h.id();
  h.dictation.onHelperEvent({
    type: "capture.started",
    id,
    startMs: 40,
    relayMs: null,
    asrState: null,
  });
  vi.advanceTimersByTime(holdMs);
  h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
  return id;
}

describe("createDictation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("a hotkey down or toggle during a transform run starts no capture", () => {
    const h = harness();
    h.store.update((s) => ({
      ...s,
      transform: { phase: "reading", id: "r1", transformId: POLISH_ID },
    }));

    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    h.dictation.onHelperEvent({ type: "hotkey", action: "toggle", uptimeMs: null });

    expect(h.commands).toEqual([]);
    expect(h.store.state.session).toEqual(idle);

    // Once the run has its outcome, dictation starts again.
    h.store.update((s) => ({
      ...s,
      transform: { phase: "done", id: "r1", outcome: { kind: "noSelection" } },
    }));
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    expect(h.commands.map((c) => c.type)).toEqual(["capture.start"]);
  });

  test("a show request waits for a transform run as it waits for a dictation", async () => {
    const h = harness();
    const shown: string[] = [];
    const runWhenIdle = whenIdle(h.store);
    h.store.update((s) => ({
      ...s,
      transform: { phase: "generating", id: "r1", transformId: POLISH_ID, via: "copy", words: 2 },
    }));

    runWhenIdle(() => shown.push(h.store.state.transform.phase));
    expect(shown).toEqual([]);

    h.store.update((s) => ({
      ...s,
      transform: { phase: "done", id: "r1", outcome: { kind: "cancelled" } },
    }));
    await Promise.resolve();
    expect(shown).toEqual(["done"]);
  });

  test("forwards only parameter-free helper log lines to diagnostics", () => {
    const h = harness();
    h.dictation.onHelperEvent({ type: "log", level: "info", message: "hotkey tap installed" });
    h.dictation.onHelperEvent({
      type: "log",
      level: "error",
      message: "capture.stop 1234 ignored: no such active session",
    });
    h.dictation.onHelperEvent({
      type: "log",
      level: "error",
      message: "microphone list failed: x",
    });
    expect(h.logs).toEqual([
      "helper info: hotkey tap installed",
      "helper error: capture.stop 1234 ignored: no such active session",
      "helper error: microphone list failed: x",
    ]);
    expect(h.entries).toEqual([{ message: "hotkey tap installed", level: "info" }]);
  });

  test.each(dictationLanguages)("passes $label to speech recognition", ({ value }) => {
    const h = harness({ dictationLanguage: value });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    expect(h.commands).toEqual([
      {
        type: "capture.start",
        id: h.id(),
        outputVolumeScale: null,
        language: value,
        microphone: null,
        detectHost: expect.any(Boolean),
      },
    ]);
  });

  test.each<[string, Options, boolean]>([
    ["cleanup runs", {}, true],
    ["cleanup is off", { cleanupEnabled: false }, false],
    ["the language has no cleanup", { dictationLanguage: "pl" }, false],
  ])("asks the helper for the page host only when %s", (_, opts, detectHost) => {
    const h = harness(opts);
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    expect(h.commands).toEqual([expect.objectContaining({ type: "capture.start", detectHost })]);
  });

  test("snapshots the microphone per session and applies a changed choice next time", () => {
    const h = harness();
    const microphone = { uid: "usb", name: "USB Microphone" };
    h.store.update((state) => ({ ...state, settings: { ...state.settings, microphone } }));
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    expect(h.commands.at(-1)).toMatchObject({ type: "capture.start", microphone });
    h.store.update((state) => ({ ...state, settings: { ...state.settings, microphone: null } }));
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]).toMatchObject({ microphone });
    h.dictation.onHelperEvent({ type: "hotkey", action: "cancel", uptimeMs: null });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
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

  test.each([
    { lowerAudioWhileDictating: false, lowerAudioByPercent: 90, outputVolumeScale: null },
    { lowerAudioWhileDictating: true, lowerAudioByPercent: 90, outputVolumeScale: 0.1 },
    { lowerAudioWhileDictating: true, lowerAudioByPercent: 40, outputVolumeScale: 0.6 },
    { lowerAudioWhileDictating: true, lowerAudioByPercent: 100, outputVolumeScale: 0 },
  ])(
    "asks the helper to keep $outputVolumeScale of the output volume when lowering is $lowerAudioWhileDictating at $lowerAudioByPercent%",
    ({ outputVolumeScale, ...lowering }) => {
      const h = harness();
      h.store.update((state) => ({ ...state, settings: { ...state.settings, ...lowering } }));
      h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
      expect(h.commands).toEqual([
        expect.objectContaining({ type: "capture.start", outputVolumeScale }),
      ]);
    },
  );

  test("snapshots the output volume once per capture start", () => {
    const h = harness();
    h.store.update((state) => ({
      ...state,
      settings: { ...state.settings, lowerAudioWhileDictating: true },
    }));
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const first = h.id();
    expect(h.commands).toEqual([
      {
        type: "capture.start",
        id: first,
        language: "en",
        outputVolumeScale: 0.3,
        microphone: null,
        detectHost: true,
      },
    ]);
    h.store.update((state) => ({
      ...state,
      settings: { ...state.settings, lowerAudioWhileDictating: false },
    }));
    expect(h.commands).toHaveLength(1);
    h.dictation.onHelperEvent({ type: "hotkey", action: "cancel", uptimeMs: null });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    expect(h.commands.at(-1)).toEqual({
      type: "capture.start",
      microphone: null,
      id: h.id(),
      language: "en",
      outputVolumeScale: null,
      detectHost: true,
    });
  });

  test("drives a full session from hotkey down to inserted and back to idle", async () => {
    const h = harness();
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const id = h.id();
    expect(h.commands).toEqual([
      {
        type: "capture.start",
        id,
        language: "en",
        outputVolumeScale: null,
        microphone: null,
        detectHost: true,
      },
    ]);
    h.dictation.onHelperEvent({
      type: "capture.started",
      id,
      startMs: 40,
      relayMs: null,
      asrState: null,
    });
    h.dictation.onHelperEvent({ type: "capture.level", id, level: 0.4 });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
    expect(h.commands.at(-1)).toEqual({ type: "capture.stop", id });
    h.dictation.onHelperEvent({
      type: "transcript",
      id,
      text: "hello world",
      audioMs: 800,
      asrMs: 120,
      speechMs: 600,
      relayMs: null,
      target: null,
    });
    await flush();
    expect(h.cleans).toEqual(["hello world"]);
    expect(h.budgets).toEqual([cleanupBudgetMs("hello world")]);
    expect(h.entries).toEqual([]);
    expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: "hello world.", html: null });
    expect(h.latest()).toEqual({
      id,
      at: expect.any(Number),
      raw: "hello world",
      text: "hello world.",
      status: "pending",
    });
    h.dictation.onHelperEvent({
      type: "insert.result",
      id,
      method: "accessibility",
      route: "direct",
    });
    expect(h.latest()).toMatchObject({ id, status: "inserted" });
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
      /outcome=inserted startMs=40 audioMs=800 asrMs=120 cleanupMs=\d+ cleanupQueueMs=2 cleanupGenerateMs=5 insertMs=\d+ releaseToInsertMs=\d+/,
    );
    expect(timing).not.toContain("hello");
  });

  test("a toggle starts a session and the next toggle stops it, while the hold key's release and chord are ignored", () => {
    const h = harness();
    h.dictation.onHelperEvent({ type: "hotkey", action: "toggle", uptimeMs: null });
    const id = h.id();
    expect(h.commands).toEqual([
      {
        type: "capture.start",
        id,
        language: "en",
        outputVolumeScale: null,
        microphone: null,
        detectHost: true,
      },
    ]);
    h.dictation.onHelperEvent({
      type: "capture.started",
      id,
      startMs: 40,
      relayMs: null,
      asrState: null,
    });
    vi.advanceTimersByTime(5000);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
    h.dictation.onHelperEvent({ type: "hotkey", action: "chord", uptimeMs: null });
    expect(h.commands).toHaveLength(1);
    expect(h.store.state.session).toMatchObject({ phase: "recording", id, mode: "toggle" });
    h.dictation.onHelperEvent({ type: "hotkey", action: "toggle", uptimeMs: null });
    expect(h.commands.at(-1)).toEqual({ type: "capture.stop", id });
    expect(h.store.state.session).toMatchObject({ phase: "transcribing", id });
  });

  test("a chord on the hold key cancels its capture", () => {
    const h = harness();
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const id = h.id();
    h.dictation.onHelperEvent({ type: "hotkey", action: "chord", uptimeMs: null });
    expect(h.commands.at(-1)).toEqual({ type: "capture.cancel", id });
    expect(h.store.state.session).toEqual(idle);
  });

  test("reports a finished session once, with the logged timings and no text or id", async () => {
    const h = harness({ dictationLanguage: "en" });
    const pressedAt = Date.now();
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const id = h.id();
    h.dictation.onHelperEvent({
      type: "capture.started",
      id,
      startMs: 40,
      relayMs: 6,
      asrState: "cold",
    });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
    h.dictation.onHelperEvent({
      type: "transcript",
      id,
      text: "call Anna",
      audioMs: 800,
      asrMs: 120,
      speechMs: 600,
      relayMs: 4,
      target: null,
    });
    await flush();
    vi.advanceTimersByTime(30);
    h.dictation.onHelperEvent({
      type: "insert.result",
      id,
      method: "paste",
      route: "unchanged",
      clipboardSaveMs: 3,
    });
    vi.advanceTimersByTime(IDLE_AFTER_INSERTED_MS);
    expect(h.reports).toEqual([
      {
        outcome: { kind: "inserted", method: "paste" },
        finishedAt: pressedAt + 830,
        capture: {
          language: "en",
          pressedAt,
          insertRoute: "unchanged",
          asrState: "cold",
          timings: {
            startMs: 40,
            pressRelayMs: 6,
            audioMs: 800,
            releaseRelayMs: 4,
            asrMs: 120,
            cleanupMs: 0,
            cleanupQueueMs: 2,
            cleanupGenerateMs: 5,
            insertMs: 30,
            clipboardSaveMs: 3,
            releaseToInsertMs: 30,
          },
        },
      },
    ]);
    expect(h.logs).toContain(
      `session ${id.slice(0, 8)} outcome=inserted startMs=40 pressRelayMs=6 audioMs=800 releaseRelayMs=4 asrMs=120 cleanupMs=0 cleanupQueueMs=2 cleanupGenerateMs=5 insertMs=30 clipboardSaveMs=3 releaseToInsertMs=30 insertRoute=unchanged asrState=cold`,
    );
    const json = JSON.stringify(h.reports);
    expect(json).not.toContain("Anna");
    expect(json).not.toContain(id.slice(0, 8));
  });

  test("inserts and records dictations into Mail and Gmail, hands Insights only the app and category, and never logs or reports the target", async () => {
    const h = harness();
    for (const to of [mailApp, chromeAt("mail.google.com")]) {
      const id = await dictate(h, "hello world", to);
      expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: "hello world.", html: null });
      h.dictation.onHelperEvent({
        type: "insert.result",
        id,
        method: "accessibility",
        route: "direct",
      });
      vi.advanceTimersByTime(IDLE_AFTER_INSERTED_MS);
    }
    expect(h.styles.map(({ layout }) => layout)).toEqual(["email", "email"]);
    expect(h.recorded()).toMatchObject([
      { text: "hello world.", status: "inserted" },
      { text: "hello world.", status: "inserted" },
    ]);
    expect(h.reports.map((report) => report.outcome.kind)).toEqual(["inserted", "inserted"]);
    expect(h.dictated.map(({ destination }) => destination)).toEqual([
      { bundleId: "com.apple.mail", category: "email" },
      { bundleId: "com.google.chrome", category: "email" },
    ]);
    expect(JSON.stringify(h.dictated)).not.toContain("mail.google.com");
    const diagnostics = JSON.stringify([h.logs, h.entries, h.reports, h.recorded()]).toLowerCase();
    for (const key of ["com.apple.mail", "com.google.chrome", "mail.google.com"]) {
      expect(diagnostics).not.toContain(key);
    }
  });

  test("hands Insights the category of the app even with cleanup off", async () => {
    const h = harness({ cleanupEnabled: false });
    const id = await dictate(h, "hello world", mailApp);
    h.dictation.onHelperEvent({
      type: "insert.result",
      id,
      method: "paste",
      route: "forced",
      clipboardSaveMs: null,
    });
    expect(h.styles).toEqual([]);
    expect(h.dictated[0]?.destination).toEqual({ bundleId: "com.apple.mail", category: "email" });
  });

  test("a duplicate transcript from another app leaves the session credited to the first", async () => {
    const h = harness();
    const id = await dictate(h, "hello world", mailApp);
    h.dictation.onHelperEvent(
      transcriptEvent(id, "hello world", target("com.tinyspeck.slackmacgap")),
    );
    await flush();
    h.dictation.onHelperEvent({
      type: "insert.result",
      id,
      method: "paste",
      route: "forced",
      clipboardSaveMs: null,
    });
    expect(h.dictated.map(({ destination }) => destination)).toEqual([
      { bundleId: "com.apple.mail", category: "email" },
    ]);
  });

  test("a transcript that arrives before capture starts does not decide where the session counts", async () => {
    const h = harness();
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const id = h.id();
    const transcript = (to: Target | null) =>
      h.dictation.onHelperEvent(transcriptEvent(id, "hello world", to));
    transcript(mailApp);
    h.dictation.onHelperEvent({
      type: "capture.started",
      id,
      startMs: 40,
      relayMs: null,
      asrState: null,
    });
    transcript(target("com.tinyspeck.slackmacgap"));
    await flush();
    h.dictation.onHelperEvent({
      type: "insert.result",
      id,
      method: "paste",
      route: "forced",
      clipboardSaveMs: null,
    });
    expect(h.styles).toEqual([{ style: "formal", layout: "general" }]);
    expect(h.dictated.map(({ destination }) => destination)).toEqual([
      { bundleId: "com.tinyspeck.slackmacgap", category: "work" },
    ]);
  });

  test("an app reassigned mid-session keeps the category its words were styled for", async () => {
    const h = harness({ cleanHangs: true });
    const id = await dictate(h, "hello world", mailApp);
    h.store.update((s) => ({
      ...s,
      settings: {
        ...s.settings,
        cleanup: {
          ...s.settings.cleanup,
          assignments: parseAssignments([
            { kind: "app", bundleId: "com.apple.mail", name: "Mail", category: "personal" },
          ]),
        },
      },
    }));
    h.hung[0]!({ text: "Hello world.", chunks: 1, cleaned: 1, queueMs: 0, generateMs: 0 });
    await flush();
    h.dictation.onHelperEvent({
      type: "insert.result",
      id,
      method: "paste",
      route: "forced",
      clipboardSaveMs: null,
    });
    expect(h.styles).toEqual([{ style: "formal", layout: "email" }]);
    expect(h.dictated[0]?.destination).toEqual({ bundleId: "com.apple.mail", category: "email" });
  });

  test("releaseToInsertMs counts from the release even when capture caught up later", () => {
    const h = harness({ cleanupEnabled: false });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const id = h.id();
    vi.advanceTimersByTime(300);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
    vi.advanceTimersByTime(200);
    h.dictation.onHelperEvent({
      type: "capture.started",
      id,
      startMs: 500,
      relayMs: null,
      asrState: null,
    });
    expect(h.commands.at(-1)).toEqual({ type: "capture.stop", id });
    h.dictation.onHelperEvent({
      type: "transcript",
      id,
      text: "hi",
      audioMs: 0,
      asrMs: 10,
      speechMs: 600,
      relayMs: null,
      target: null,
    });
    vi.advanceTimersByTime(100);
    h.dictation.onHelperEvent({
      type: "insert.result",
      id,
      method: "paste",
      route: "forced",
      clipboardSaveMs: null,
    });
    expect(h.reports[0]?.capture?.timings.releaseToInsertMs).toBe(300);
  });

  test("reports a failed session once, with its language", () => {
    const h = harness({ dictationLanguage: "pl" });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const id = h.id();
    h.dictation.onHelperEvent({
      type: "capture.started",
      id,
      startMs: 25,
      relayMs: null,
      asrState: null,
    });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
    h.dictation.onHelperEvent({ type: "transcript.failed", id, message: "decoder broke" });
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({ capture: { language: "pl", timings: { startMs: 25 } } });
    expect(h.reports[0]?.outcome.kind).toBe("failed");
    expect(h.reports[0]?.capture?.timings.releaseToInsertMs).toBeUndefined();
  });

  test("hands each session with a usable transcript to Insights, inserted or not, with where it went when known", async () => {
    const h = harness({ dictionary: [{ id: "1", phrase: "Hadryś", replacement: null }] });
    const first = await dictate(h, "ask hadrys");
    h.dictation.onHelperEvent({
      type: "insert.result",
      id: first,
      method: "paste",
      route: "forced",
      clipboardSaveMs: null,
    });
    const firstAt = Date.now();
    const second = await dictate(h, "hello there", mailApp);
    h.dictation.onHelperEvent({
      type: "insert.result",
      id: second,
      method: "none",
      reason: "secureInput",
    });
    expect(h.dictated).toEqual([
      {
        raw: "ask hadrys",
        insertedCleanup: "ask hadrys.",
        dictionaryFixes: 1,
        language: "en",
        paceMs: 600,
        finishedAt: firstAt,
        destination: null,
      },
      {
        raw: "hello there",
        insertedCleanup: "hello there.",
        dictionaryFixes: 0,
        language: "en",
        paceMs: 600,
        finishedAt: Date.now(),
        destination: { bundleId: "com.apple.mail", category: "email" },
      },
    ]);
    expect(h.reports.map((report) => report.outcome.kind)).toEqual(["inserted", "notInserted"]);
  });

  test("never hands over an empty, too short, failed, or superseded session", async () => {
    const h = harness();
    await dictate(h, "");
    release(h, 100);
    const failed = release(h, 800);
    h.dictation.onHelperEvent({ type: "transcript.failed", id: failed, message: "decoder broke" });
    const superseded = release(h, 800);
    h.dictation.dispatch({ type: "helperExited" });
    h.dictation.onHelperEvent({
      type: "transcript",
      id: superseded,
      text: "late words",
      audioMs: 800,
      asrMs: 100,
      speechMs: 600,
      relayMs: null,
      target: null,
    });
    await flush();
    expect(h.reports.map((report) => report.outcome.kind)).toEqual([
      "empty",
      "tooShort",
      "failed",
      "failed",
    ]);
    expect(h.dictated).toEqual([]);
  });

  test("hands over no cleanup output when the raw transcript was inserted", async () => {
    const email = {
      id: "s",
      trigger: "my email",
      expansion: "name@example.com",
      expansionHtml: null,
      enabled: true,
    };
    const lost = harness({ cleanHangs: true, snippets: [email] });
    const id = await dictate(lost, "send it to my email");
    lost.hung[0]!({ text: "Send it.", chunks: 1, cleaned: 1, queueMs: 0, generateMs: 0 });
    await flush();
    lost.dictation.onHelperEvent({
      type: "insert.result",
      id,
      method: "paste",
      route: "forced",
      clipboardSaveMs: null,
    });
    const off = harness({ cleanupEnabled: false });
    const offId = await dictate(off, "um hello");
    off.dictation.onHelperEvent({
      type: "insert.result",
      id: offId,
      method: "paste",
      route: "forced",
      clipboardSaveMs: null,
    });
    const failing = harness({ cleanFails: "rejects" });
    const failingId = await dictate(failing, "um hello");
    failing.dictation.onHelperEvent({
      type: "insert.result",
      id: failingId,
      method: "paste",
      route: "forced",
      clipboardSaveMs: null,
    });
    for (const h of [lost, off, failing]) {
      expect(h.dictated).toHaveLength(1);
      expect(h.dictated[0]?.insertedCleanup).toBeNull();
    }
    expect(lost.commands.at(-1)).toEqual({
      type: "insert",
      id,
      text: "send it to name@example.com",
      html: null,
    });
  });

  test("hands over the audio length as the speech span when the helper sent none", async () => {
    const h = harness({ cleanupEnabled: false });
    const id = release(h, 800);
    h.dictation.onHelperEvent({
      type: "transcript",
      id,
      text: "hello",
      audioMs: 900,
      asrMs: 100,
      speechMs: null,
      relayMs: null,
      target: null,
    });
    h.dictation.onHelperEvent({
      type: "insert.result",
      id,
      method: "paste",
      route: "forced",
      clipboardSaveMs: null,
    });
    expect(h.dictated[0]?.paceMs).toBe(900);
  });

  test("reports a session that ended before capture without the previous session's data", () => {
    const h = harness({ dictationLanguage: "pl" });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const first = h.id();
    h.dictation.onHelperEvent({
      type: "capture.started",
      id: first,
      startMs: 25,
      relayMs: null,
      asrState: null,
    });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
    h.dictation.onHelperEvent({ type: "transcript.failed", id: first, message: "decoder broke" });
    vi.advanceTimersByTime(IDLE_AFTER_OTHER_MS);
    h.store.update((s) => ({ ...s, models: { ...s.models, asr: { state: "missing" } } }));
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    expect(h.reports).toHaveLength(2);
    expect(h.reports[1]).toEqual({
      outcome: { kind: "failed", message: ASR_MISSING_MESSAGE },
      finishedAt: Date.now(),
      capture: null,
    });
  });

  test("reports a second refused press while the first refusal is still shown", () => {
    const h = harness({ asrModel: { state: "missing" } });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    expect(h.reports).toHaveLength(1);
    vi.advanceTimersByTime(IDLE_AFTER_OTHER_MS - 500);
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    expect(h.store.state.session).toMatchObject({
      phase: "done",
      outcome: { kind: "failed", message: ASR_MISSING_MESSAGE },
    });
    expect(h.reports).toHaveLength(2);
    expect(h.reports[1]).toEqual({
      outcome: { kind: "failed", message: ASR_MISSING_MESSAGE },
      finishedAt: Date.now(),
      capture: null,
    });
    expect(h.logs.filter((line) => line.startsWith("session "))).toHaveLength(2);
  });

  const SPREAD: CategoryStyles = {
    personal: "veryCasual",
    work: "casual",
    email: "formal",
    other: "formal",
  };

  test.each<[string, Target | null, readonly Assignment[], CleanupStyle]>([
    ["Mail", mailApp, [], { style: "formal", layout: "email" }],
    ["Messages", target("com.apple.MobileSMS"), [], { style: "veryCasual", layout: "general" }],
    ["Gmail in Chrome", chromeAt("mail.google.com"), [], { style: "formal", layout: "email" }],
    [
      "another site in Chrome",
      chromeAt("duckduckgo.com"),
      [],
      { style: "formal", layout: "general" },
    ],
    ["an unknown target", null, [], { style: "formal", layout: "general" }],
    [
      "Mail with a host that does not parse",
      target("com.apple.mail", "not a host"),
      [],
      { style: "formal", layout: "email" },
    ],
    [
      "a site the user put in Work",
      chromeAt("duckduckgo.com"),
      parseAssignments([{ kind: "site", host: "duckduckgo.com", category: "work" }]),
      { style: "casual", layout: "general" },
    ],
    [
      "Mail moved to Personal",
      mailApp,
      parseAssignments([
        { kind: "app", bundleId: "com.apple.mail", name: "Mail", category: "personal" },
      ]),
      { style: "veryCasual", layout: "general" },
    ],
  ])("cleans a dictation into %s with %j", async (_, to, assignments, expected) => {
    const h = harness({ styles: SPREAD, assignments });
    await dictate(h, "hey", to);
    expect(h.styles).toStrictEqual([expected]);
  });

  test("a release after the minimum hold keeps the GPU busy until the clean starts", async () => {
    const h = harness();
    const id = release(h, 800);
    expect(h.gpu).toEqual(["busy"]);
    expect(h.cleans).toEqual([]);
    h.helper.transcript(id, "hey");
    await flush();
    expect(h.cleans).toEqual(["hey"]);
    expect(h.gpu).toEqual(["busy"]);
  });

  test("a capture the helper stops on its own keeps the GPU busy", () => {
    const h = harness();
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const id = h.id();
    h.dictation.onHelperEvent({
      type: "capture.started",
      id,
      startMs: 40,
      relayMs: null,
      asrState: null,
    });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "capture.stopped", id, reason: "maxDuration" });
    expect(h.gpu).toEqual(["busy"]);
  });

  test("a tap too short to transcribe leaves the GPU alone", () => {
    const h = harness();
    release(h, 100);
    expect(h.gpu).toEqual([]);
  });

  test("an empty transcript lets the GPU idle at once", async () => {
    const h = harness();
    const id = release(h, 800);
    h.helper.transcript(id, "  ");
    await flush();
    expect(h.cleans).toEqual([]);
    expect(h.gpu).toEqual(["busy", "idle"]);
    expect(h.latest()).toBeNull();
  });

  test("a failed transcription lets the GPU idle at once", () => {
    const h = harness();
    const id = release(h, 800);
    h.dictation.onHelperEvent({ type: "transcript.failed", id, message: "decoder crashed" });
    expect(h.gpu).toEqual(["busy", "idle"]);
  });

  test("an overdue transcription keeps the GPU busy", () => {
    const h = harness();
    const id = release(h, 800);
    vi.advanceTimersByTime(TRANSCRIBE_TIMEOUT_MS);
    expect(h.store.state.session).toEqual({ phase: "transcribing", id, overdue: true });
    expect(h.gpu).toEqual(["busy"]);
  });

  test.each<[string, Options]>([
    ["cleanup is off", { cleanupEnabled: false }],
    ["the language has no cleanup", { dictationLanguage: "de" }],
    ["the model is not loaded", { cleanupLoaded: false }],
  ])(
    "a release leaves the GPU idle when %s, and the transcript is inserted raw",
    async (_, opts) => {
      const h = harness(opts);
      const id = release(h, 800);
      expect(h.gpu).toEqual([]);
      h.helper.transcript(id, "hey");
      await flush();
      expect(h.cleans).toEqual([]);
      expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: "hey", html: null });
    },
  );

  test("a dictation of only a trigger inserts the saved expansion without running cleanup", async () => {
    const expansion = "Best,\nAlex";
    const h = harness({
      snippets: [{ id: "1", trigger: "sign off", expansion, expansionHtml: null, enabled: true }],
    });
    const id = await dictate(h, "Sign off.");
    expect(h.cleans).toEqual([]);
    expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: expansion, html: null });
    expect(h.latest()).toMatchObject({ raw: "Sign off.", text: expansion });
  });

  test.each<[string, Options, string, string]>([
    ["the language has no cleanup", { dictationLanguage: "de" }, "hallo welt", "hallo welt"],
    [
      "the dictation is only a trigger",
      {
        snippets: [
          {
            id: "1",
            trigger: "sign off",
            expansion: "Best,\nAlex",
            expansionHtml: null,
            enabled: true,
          },
        ],
      },
      "Sign off.",
      "Best,\nAlex",
    ],
  ])("a dictation into Mail skips cleanup when %s", async (_, opts, text, inserted) => {
    const h = harness(opts);
    const id = await dictate(h, text, mailApp);
    expect(h.cleans).toEqual([]);
    expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: inserted, html: null });
  });

  test("a formatted snippet sends its HTML to the helper and keeps history plain", async () => {
    const h = harness({ snippets: [formattedName] });
    const id = await dictate(h, "sign it my name");
    expect(h.commands.at(-1)).toEqual({
      type: "insert",
      id,
      text: "sign it Ana.",
      html: "sign it <em>Ana</em>.",
    });
    expect(h.latest()).toMatchObject({ raw: "sign it my name", text: "sign it Ana." });
  });

  test("the saved dictionary fixes the cleaned text while cleanup and history get the raw words", async () => {
    const h = harness({ dictionary: [{ id: "1", phrase: "Hadryś", replacement: null }] });
    const id = await dictate(h, "ask hadrys");
    expect(h.cleans).toEqual(["ask hadrys"]);
    expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: "ask Hadryś.", html: null });
    expect(h.latest()).toMatchObject({ raw: "ask hadrys", text: "ask Hadryś." });
  });

  test.each([
    ["cleanup is disabled", { cleanupEnabled: false }],
    ["the cleanup model is not loaded", { cleanupLoaded: false }],
  ])("inserts the raw transcript when %s", async (_name, opts) => {
    const h = harness(opts);
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const id = h.id();
    h.dictation.onHelperEvent({
      type: "capture.started",
      id,
      startMs: 40,
      relayMs: null,
      asrState: null,
    });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
    h.dictation.onHelperEvent({
      type: "transcript",
      id,
      text: "raw words",
      audioMs: 800,
      asrMs: 100,
      speechMs: 600,
      relayMs: null,
      target: null,
    });
    await flush();
    expect(h.cleans).toEqual([]);
    expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: "raw words", html: null });
  });

  test.each(dictationLanguages.filter(({ value }) => value !== "en"))(
    "$label preserves the original Unicode transcript through insertion",
    async ({ value }) => {
      const h = harness({ dictationLanguage: value });
      const raw = "Zażółć gęślą jaźń.\nПривіт, світе! Café à 15:30.";
      h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
      const id = h.id();
      expect(h.commands).toEqual([
        {
          type: "capture.start",
          id,
          language: value,
          outputVolumeScale: null,
          microphone: null,
          detectHost: false,
        },
      ]);
      h.dictation.onHelperEvent({
        type: "capture.started",
        id,
        startMs: 40,
        relayMs: null,
        asrState: null,
      });
      vi.advanceTimersByTime(800);
      h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
      h.dictation.onHelperEvent({
        type: "transcript",
        id,
        text: raw,
        audioMs: 800,
        asrMs: 100,
        speechMs: 600,
        relayMs: null,
        target: null,
      });
      await flush();
      expect(h.cleans).toEqual([]);
      expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: raw, html: null });
      expect(h.latest()).toMatchObject({ raw, text: raw });
      h.dictation.onHelperEvent({
        type: "insert.result",
        id,
        method: "accessibility",
        route: "direct",
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
      h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
      const first = h.id();
      expect(h.commands.at(-1)).toMatchObject({
        type: "capture.start",
        language: before,
        microphone: null,
      });
      h.dictation.onHelperEvent({
        type: "capture.started",
        id: first,
        startMs: 40,
        relayMs: null,
        asrState: null,
      });
      h.store.update((s) => ({ ...s, settings: { ...s.settings, dictationLanguage: after } }));
      vi.advanceTimersByTime(800);
      h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
      h.dictation.onHelperEvent({
        type: "transcript",
        id: first,
        text: "first",
        audioMs: 800,
        asrMs: 100,
        speechMs: 600,
        relayMs: null,
        target: null,
      });
      await flush();
      expect(h.commands.at(-1)).toEqual({
        type: "insert",
        id: first,
        text: firstCleaned ? "first." : "first",
        html: null,
      });
      h.dictation.onHelperEvent({
        type: "insert.result",
        id: first,
        method: "paste",
        route: "forced",
        clipboardSaveMs: null,
      });
      h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
      const second = h.id();
      expect(h.commands.at(-1)).toMatchObject({
        type: "capture.start",
        language: after,
        microphone: null,
      });
      h.dictation.onHelperEvent({
        type: "capture.started",
        id: second,
        startMs: 40,
        relayMs: null,
        asrState: null,
      });
      vi.advanceTimersByTime(800);
      h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
      h.dictation.onHelperEvent({
        type: "transcript",
        id: second,
        text: "second",
        audioMs: 800,
        asrMs: 100,
        speechMs: 600,
        relayMs: null,
        target: null,
      });
      await flush();
      expect(h.commands.at(-1)).toEqual({
        type: "insert",
        id: second,
        text: firstCleaned ? "second" : "second.",
        html: null,
      });
      expect(h.cleans).toEqual([firstCleaned ? "first" : "second"]);
    },
  );

  test("a transcript during the cleanup warm-up is cleaned, not inserted raw", async () => {
    const h = harness();
    h.store.update((s) => ({ ...s, models: { ...s.models, cleanup: { state: "loading" } } }));
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const id = h.id();
    h.dictation.onHelperEvent({
      type: "capture.started",
      id,
      startMs: 40,
      relayMs: null,
      asrState: null,
    });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
    h.dictation.onHelperEvent({
      type: "transcript",
      id,
      text: "hi",
      audioMs: 800,
      asrMs: 100,
      speechMs: 600,
      relayMs: null,
      target: null,
    });
    await flush();
    expect(h.cleans).toEqual(["hi"]);
    expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: "hi.", html: null });
  });

  test.each(["rejects", "throws"] as const)(
    "a cleanup that %s inserts the raw transcript with the dictionary applied",
    async (cleanFails) => {
      const h = harness({
        cleanFails,
        dictionary: [{ id: "1", phrase: "Hadryś", replacement: null }],
      });
      h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
      const id = h.id();
      h.dictation.onHelperEvent({
        type: "capture.started",
        id,
        startMs: 40,
        relayMs: null,
        asrState: null,
      });
      vi.advanceTimersByTime(800);
      h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
      h.dictation.onHelperEvent({
        type: "transcript",
        id,
        text: "keep hadrys",
        audioMs: 800,
        asrMs: 100,
        speechMs: 600,
        relayMs: null,
        target: null,
      });
      await flush();
      expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: "keep Hadryś", html: null });
      expect(h.latest()).toMatchObject({ raw: "keep hadrys", text: "keep Hadryś" });
      expect(h.logs).toContain("cleanup failed: model crashed");
      expect(h.entries).toEqual([
        { message: "cleanup failed", level: "warn", attributes: { "error.type": "Error" } },
      ]);
    },
  );

  test("a failed cleanup of a Mail dictation inserts the raw transcript with the dictionary applied", async () => {
    const h = harness({
      cleanFails: "rejects",
      dictionary: [{ id: "1", phrase: "Hadryś", replacement: null }],
    });
    const id = await dictate(h, "keep hadrys", mailApp);
    expect(h.styles).toEqual([{ style: "formal", layout: "email" }]);
    expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: "keep Hadryś", html: null });
    expect(h.latest()).toMatchObject({ raw: "keep hadrys", text: "keep Hadryś" });
  });

  test("a cleanup that never settles is aborted after the budget and a grace, inserts the raw text, and ignores the late result", async () => {
    const h = harness({ cleanHangs: true });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const id = h.id();
    h.dictation.onHelperEvent({
      type: "capture.started",
      id,
      startMs: 40,
      relayMs: null,
      asrState: null,
    });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
    h.dictation.onHelperEvent({
      type: "transcript",
      id,
      text: "one two three",
      audioMs: 800,
      asrMs: 100,
      speechMs: 600,
      relayMs: null,
      target: null,
    });
    await flush();
    const budgetMs = cleanupBudgetMs("one two three");
    expect(h.cleans).toEqual(["one two three"]);
    expect(h.budgets).toEqual([budgetMs]);
    await vi.advanceTimersByTimeAsync(budgetMs + CLEANUP_GRACE_MS - 1);
    expect(h.commands.at(-1)).toEqual({ type: "capture.stop", id });
    expect(h.signals[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.signals[0]!.aborted).toBe(true);
    expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: "one two three", html: null });
    expect(h.logs).toContainEqual(expect.stringContaining("cleanup timed out"));
    expect(h.entries).toEqual([
      {
        message: "cleanup timed out",
        level: "warn",
        attributes: { "cleanup.budget_ms": budgetMs },
      },
    ]);
    h.hung[0]!({ text: "late polished text", chunks: 1, cleaned: 1, queueMs: 0, generateMs: 0 });
    await flush();
    expect(h.commands.filter((c) => c.type === "insert")).toEqual([
      { type: "insert", id, text: "one two three", html: null },
    ]);
    expect(h.latest()).toMatchObject({ raw: "one two three", text: "one two three" });
  });

  test("a partial cleanup inserts the stitched text and logs the share that was cleaned, without the text", async () => {
    const h = harness({ cleanPartial: true });
    const id = await dictate(h, "one two three");
    const budgetMs = cleanupBudgetMs("one two three");
    expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: "one two three.", html: null });
    expect(h.latest()).toMatchObject({ raw: "one two three", text: "one two three." });
    expect(h.logs).toContain(`cleanup partial: 1 of 3 chunks cleaned, budget ${budgetMs} ms`);
    expect(h.entries).toEqual([
      {
        message: "cleanup partial",
        level: "info",
        attributes: { "cleanup.chunks": 3, "cleanup.cleaned": 1, "cleanup.budget_ms": budgetMs },
      },
    ]);
  });

  test("cleanup budget grows with the input and is capped", () => {
    expect(cleanupBudgetMs("")).toBe(CLEANUP_BUDGET.base);
    expect(cleanupBudgetMs("a b c")).toBe(CLEANUP_BUDGET.base + 3 * CLEANUP_BUDGET.perWord);
    expect(cleanupBudgetMs("w ".repeat(1000))).toBe(CLEANUP_BUDGET.max);
  });

  test("the next session is cleaned even when the earlier aborted cleanup has not settled yet", async () => {
    const h = harness({ cleanHangs: true });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const first = h.id();
    h.dictation.onHelperEvent({
      type: "capture.started",
      id: first,
      startMs: 40,
      relayMs: null,
      asrState: null,
    });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
    h.dictation.onHelperEvent({
      type: "transcript",
      id: first,
      text: "one",
      audioMs: 800,
      asrMs: 100,
      speechMs: 600,
      relayMs: null,
      target: null,
    });
    await vi.advanceTimersByTimeAsync(cleanupBudgetMs("one") + CLEANUP_GRACE_MS);
    h.dictation.onHelperEvent({
      type: "insert.result",
      id: first,
      method: "paste",
      route: "forced",
      clipboardSaveMs: null,
    });
    await vi.advanceTimersByTimeAsync(IDLE_AFTER_INSERTED_MS);

    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const second = h.id();
    h.dictation.onHelperEvent({
      type: "capture.started",
      id: second,
      startMs: 40,
      relayMs: null,
      asrState: null,
    });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
    h.dictation.onHelperEvent({
      type: "transcript",
      id: second,
      text: "two",
      audioMs: 800,
      asrMs: 100,
      speechMs: 600,
      relayMs: null,
      target: null,
    });
    await flush();
    expect(h.cleans).toEqual(["one", "two"]);
    expect(h.signals.map((s) => s.aborted)).toEqual([true, false]);

    h.hung[0]!({ text: "ONE", chunks: 1, cleaned: 1, queueMs: 0, generateMs: 0 });
    h.hung[1]!({ text: "Two.", chunks: 1, cleaned: 1, queueMs: 0, generateMs: 0 });
    await flush();
    expect(h.commands.filter((c) => c.type === "insert").map((c) => c.text)).toEqual([
      "one",
      "Two.",
    ]);
  });

  describe("copy transcript to clipboard", () => {
    test("copies the cleaned text once, only after insertion reports back", async () => {
      const h = harness({ copyToClipboard: true });
      const id = await dictate(h, "hello world");
      expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: "hello world.", html: null });
      expect(h.copies).toEqual([]);
      h.dictation.onHelperEvent({
        type: "insert.result",
        id,
        method: "paste",
        route: "forced",
        clipboardSaveMs: null,
      });
      expect(h.copies).toEqual([{ text: "hello world.", html: null }]);
      vi.advanceTimersByTime(IDLE_AFTER_INSERTED_MS);
      expect(h.store.state.session).toEqual(idle);
      expect(h.copies).toEqual([{ text: "hello world.", html: null }]);
    });

    test("copies the text with its snippets expanded", async () => {
      const snippets = [
        {
          id: "1",
          trigger: "my email",
          expansion: "name@example.com",
          expansionHtml: null,
          enabled: true,
        },
      ];
      const h = harness({ copyToClipboard: true, snippets });
      const id = await dictate(h, "send it to my email");
      h.dictation.onHelperEvent({
        type: "insert.result",
        id,
        method: "paste",
        route: "forced",
        clipboardSaveMs: null,
      });
      expect(h.copies).toEqual([{ text: "send it to name@example.com.", html: null }]);
    });

    test("copies both the plain text and the HTML of a formatted snippet", async () => {
      const h = harness({ copyToClipboard: true, snippets: [formattedName] });
      const id = await dictate(h, "sign it my name");
      h.dictation.onHelperEvent({
        type: "insert.result",
        id,
        method: "paste",
        route: "forced",
        clipboardSaveMs: null,
      });
      expect(h.copies).toEqual([{ text: "sign it Ana.", html: "sign it <em>Ana</em>." }]);
    });

    test("copies the text when insertion fails", async () => {
      const h = harness({ copyToClipboard: true, cleanupEnabled: false });
      const id = await dictate(h, "keep me");
      h.dictation.onHelperEvent({
        type: "insert.result",
        id,
        method: "none",
        reason: "noFocusedField",
      });
      expect(h.store.state.session).toMatchObject({
        phase: "done",
        outcome: { kind: "notInserted", copied: true },
      });
      expect(h.copies).toEqual([{ text: "keep me", html: null }]);
    });

    test("copies the text when the helper never answers the insert", async () => {
      const h = harness({ copyToClipboard: true, cleanupEnabled: false });
      await dictate(h, "stuck");
      vi.advanceTimersByTime(INSERT_TIMEOUT_MS - 1);
      expect(h.copies).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(h.copies).toEqual([{ text: "stuck", html: null }]);
    });

    test("copies the text when the helper exits mid-insert and reports it not inserted", async () => {
      const h = harness({ copyToClipboard: true, cleanupEnabled: false });
      await dictate(h, "x");
      h.dictation.dispatch({ type: "helperExited" });
      expect(h.store.state.session).toMatchObject({
        phase: "done",
        outcome: { kind: "notInserted", reason: "failed" },
      });
      expect(h.copies).toEqual([{ text: "x", html: null }]);
      expect(h.latest()).toMatchObject({ raw: "x", text: "x", status: "notInserted" });
      expect(h.dictated).toMatchObject([{ raw: "x", insertedCleanup: null }]);
    });

    test("copies the uncleaned text when the helper exits mid-cleanup and drops the cleanup", async () => {
      const h = harness({ copyToClipboard: true, cleanHangs: true });
      await dictate(h, "x");
      expect(h.store.state.session.phase).toBe("cleaning");
      h.dictation.dispatch({ type: "helperExited" });
      expect(h.store.state.session).toMatchObject({
        phase: "done",
        outcome: { kind: "notInserted", reason: "failed", copied: true },
      });
      expect(h.copies).toEqual([{ text: "x", html: null }]);
      expect(h.signals[0]!.aborted).toBe(true);
      expect(h.latest()).toMatchObject({ raw: "x", text: "x", status: "notInserted" });
      expect(h.dictated).toMatchObject([{ raw: "x", insertedCleanup: null }]);
      h.hung[0]!({ text: "x.", chunks: 1, cleaned: 1, queueMs: 0, generateMs: 0 });
      await flush();
      expect(h.commands.filter((c) => c.type === "insert")).toEqual([]);
    });

    test("copies nothing when the setting is off", async () => {
      const h = harness();
      const id = await dictate(h, "hello world");
      h.dictation.onHelperEvent({
        type: "insert.result",
        id,
        method: "paste",
        route: "forced",
        clipboardSaveMs: null,
      });
      expect(h.store.state.session).toMatchObject({ phase: "done", outcome: { kind: "inserted" } });
      expect(h.copies).toEqual([]);
    });
  });

  test("an insert the helper never answers ends notInserted after the watchdog", () => {
    const h = harness({ cleanupEnabled: false });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const id = h.id();
    h.dictation.onHelperEvent({
      type: "capture.started",
      id,
      startMs: 40,
      relayMs: null,
      asrState: null,
    });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
    h.dictation.onHelperEvent({
      type: "transcript",
      id,
      text: "stuck",
      audioMs: 800,
      asrMs: 100,
      speechMs: 600,
      relayMs: null,
      target: null,
    });
    vi.advanceTimersByTime(INSERT_TIMEOUT_MS - 1);
    expect(h.store.state.session.phase).toBe("inserting");
    vi.advanceTimersByTime(1);
    expect(h.store.state.session).toEqual({
      phase: "done",
      id,
      outcome: { kind: "notInserted", reason: "failed", copied: false },
    });
    expect(h.latest()).toMatchObject({ raw: "stuck", text: "stuck", status: "notInserted" });
  });

  test("a transcription past the watchdog keeps waiting, says so, and still inserts when it lands", () => {
    const h = harness({ cleanupEnabled: false });
    const id = release(h, 800);
    vi.advanceTimersByTime(TRANSCRIBE_TIMEOUT_MS - 1);
    expect(toSnapshot(h.store.state).session).toEqual({ kind: "processing", overdue: false });
    vi.advanceTimersByTime(1);
    expect(toSnapshot(h.store.state).session).toEqual({ kind: "processing", overdue: true });
    expect(h.commands.filter((c) => c.type === "capture.cancel")).toEqual([]);
    vi.advanceTimersByTime(10_000);
    h.helper.transcript(id, "late words");
    expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: "late words", html: null });
    expect(h.latest()).toMatchObject({ raw: "late words", text: "late words" });
  });

  test("a transcription that never finishes is cancelled at the ceiling, and the next press records", () => {
    const h = harness();
    const id = release(h, 800);
    vi.advanceTimersByTime(TRANSCRIBE_TIMEOUT_MS + TRANSCRIBE_OVERDUE_MIN_MS - 1);
    expect(h.store.state.session).toEqual({ phase: "transcribing", id, overdue: true });
    vi.advanceTimersByTime(1);
    expect(h.store.state.session).toEqual({
      phase: "done",
      id,
      outcome: { kind: "failed", message: TRANSCRIBE_GAVE_UP_MESSAGE },
    });
    expect(h.commands.at(-1)).toEqual({ type: "capture.cancel", id });
    h.helper.transcript(id, "ghost");
    expect(h.latest()).toBeNull();
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const next = h.id();
    expect(next).not.toBe(id);
    expect(h.commands.at(-1)).toMatchObject({ type: "capture.start", id: next });
    h.dictation.onHelperEvent({
      type: "capture.started",
      id: next,
      startMs: 40,
      relayMs: null,
      asrState: null,
    });
    expect(h.store.state.session).toMatchObject({ phase: "recording", id: next });
  });

  test("the ceiling gives the helper as long again as the recording lasted", () => {
    const h = harness();
    const id = release(h, 90_000);
    vi.advanceTimersByTime(TRANSCRIBE_TIMEOUT_MS + TRANSCRIBE_OVERDUE_MIN_MS);
    expect(h.store.state.session).toEqual({ phase: "transcribing", id, overdue: true });
    vi.advanceTimersByTime(90_000 - TRANSCRIBE_OVERDUE_MIN_MS);
    expect(h.store.state.session).toMatchObject({ phase: "done", id, outcome: { kind: "failed" } });
    expect(h.commands.at(-1)).toEqual({ type: "capture.cancel", id });
  });

  test("a press while a transcription is overdue sends nothing, so the busy helper is never asked", () => {
    const h = harness();
    const id = release(h, 800);
    vi.advanceTimersByTime(TRANSCRIBE_TIMEOUT_MS);
    const sent = h.commands.length;
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
    expect(h.commands.length).toBe(sent);
    expect(h.store.state.session).toEqual({ phase: "transcribing", id, overdue: true });
  });

  test("a transcript that lands after main gave up is remembered but not inserted", () => {
    const h = harness();
    const id = release(h, 800);
    vi.advanceTimersByTime(
      TRANSCRIBE_TIMEOUT_MS + TRANSCRIBE_OVERDUE_MIN_MS + IDLE_AFTER_OTHER_MS + 1,
    );
    expect(h.store.state.session).toEqual(idle);
    h.dictation.onHelperEvent({
      type: "transcript",
      id,
      text: "late",
      audioMs: 800,
      asrMs: 100,
      speechMs: 600,
      relayMs: null,
      target: null,
    });
    expect(h.latest()).toMatchObject({ raw: "late", text: "late" });
    expect(h.commands.filter((c) => c.type === "insert")).toEqual([]);
    expect(h.store.state.session).toEqual(idle);
  });

  test("a capture the helper stops on its own shows processing, logs why, and gets the transcription watchdog", () => {
    const h = harness({ cleanupEnabled: false });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const id = h.id();
    h.dictation.onHelperEvent({
      type: "capture.started",
      id,
      startMs: 40,
      relayMs: null,
      asrState: null,
    });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "capture.stopped", id, reason: "maxDuration" });
    expect(toSnapshot(h.store.state).session).toEqual({ kind: "processing", overdue: false });
    expect(h.commands.map((c) => c.type)).toEqual(["capture.start"]);
    expect(h.entries).toContainEqual({
      message: "helper stopped capture",
      level: "info",
      attributes: { "capture.stop_reason": "maxDuration" },
    });
    vi.advanceTimersByTime(TRANSCRIBE_TIMEOUT_MS - 1);
    expect(h.store.state.session.phase).toBe("transcribing");
    vi.advanceTimersByTime(1);
    expect(h.store.state.session).toEqual({ phase: "transcribing", id, overdue: true });
    expect(h.commands.map((c) => c.type)).toEqual(["capture.start"]);
    vi.advanceTimersByTime(TRANSCRIBE_OVERDUE_MIN_MS + 800 - 1);
    expect(h.store.state.session).toEqual({ phase: "transcribing", id, overdue: true });
    vi.advanceTimersByTime(1);
    expect(h.store.state.session).toMatchObject({ phase: "done", id, outcome: { kind: "failed" } });
    expect(h.commands.map((c) => c.type)).toEqual(["capture.start", "capture.cancel"]);
  });

  test("after a helper-side stop the held key's release changes nothing and the next press starts a new capture", async () => {
    const h = harness({ cleanupEnabled: false });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const id = h.id();
    h.dictation.onHelperEvent({
      type: "capture.started",
      id,
      startMs: 40,
      relayMs: null,
      asrState: null,
    });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "capture.stopped", id, reason: "deviceChanged" });
    h.dictation.onHelperEvent({
      type: "transcript",
      id,
      text: "so far",
      audioMs: 800,
      asrMs: 100,
      speechMs: 600,
      relayMs: null,
      target: null,
    });
    h.dictation.onHelperEvent({
      type: "insert.result",
      id,
      method: "paste",
      route: "forced",
      clipboardSaveMs: null,
    });
    expect(h.store.state.session).toMatchObject({
      phase: "done",
      id,
      outcome: { kind: "inserted" },
    });
    expect(h.latest()).toMatchObject({ raw: "so far", text: "so far" });
    h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
    expect(h.commands.map((c) => c.type)).toEqual(["capture.start", "insert"]);
    await vi.advanceTimersByTimeAsync(IDLE_AFTER_INSERTED_MS);
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    expect(h.store.state.session.phase).toBe("starting");
    expect(h.id()).not.toBe(id);
    expect(h.commands.at(-1)).toMatchObject({ type: "capture.start", id: h.id() });
  });

  test("a capture the helper never starts ends failed and cancels it after the watchdog", () => {
    const h = harness();
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const id = h.id();
    vi.advanceTimersByTime(START_TIMEOUT_MS - 1);
    expect(h.store.state.session.phase).toBe("starting");
    vi.advanceTimersByTime(1);
    expect(h.store.state.session).toMatchObject({ phase: "done", id, outcome: { kind: "failed" } });
    expect(h.commands).toEqual([
      {
        type: "capture.start",
        id,
        language: "en",
        outputVolumeScale: null,
        microphone: null,
        detectHost: true,
      },
      { type: "capture.cancel", id },
    ]);
  });

  test("a release while capture is still starting does not extend the start watchdog", () => {
    const h = harness();
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const id = h.id();
    vi.advanceTimersByTime(START_TIMEOUT_MS - 1);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
    vi.advanceTimersByTime(1);
    expect(h.store.state.session).toMatchObject({ phase: "done", id, outcome: { kind: "failed" } });
    expect(h.commands.at(-1)).toEqual({ type: "capture.cancel", id });
  });

  test("the transcription watchdog waits longer while the speech model is still loading", () => {
    const h = harness({ asrModel: { state: "loading" } });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const id = h.id();
    h.dictation.onHelperEvent({
      type: "capture.started",
      id,
      startMs: 40,
      relayMs: null,
      asrState: null,
    });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
    vi.advanceTimersByTime(TRANSCRIBE_TIMEOUT_MS);
    expect(h.store.state.session).toEqual({ phase: "transcribing", id, overdue: false });
    vi.advanceTimersByTime(TRANSCRIBE_WHILE_LOADING_TIMEOUT_MS - TRANSCRIBE_TIMEOUT_MS);
    expect(h.store.state.session).toEqual({ phase: "transcribing", id, overdue: true });
    expect(h.commands.filter((c) => c.type === "capture.cancel")).toEqual([]);
  });

  test("hotkey down while the speech model downloads sends nothing and names the download", () => {
    const h = harness({ asrModel: { state: "downloading", progress: 0.3 } });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    expect(h.commands).toEqual([]);
    expect(toSnapshot(h.store.state).session).toEqual({
      kind: "done",
      outcome: { kind: "failed", message: "The speech model is still downloading" },
    });
  });

  test("hotkey down with the ASR model missing sends nothing to the helper", () => {
    const h = harness();
    h.dictation.onHelperEvent({ type: "asr.status", state: "missing", message: null });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    expect(h.commands).toEqual([]);
    expect(toSnapshot(h.store.state).session).toEqual({
      kind: "done",
      outcome: { kind: "failed", message: "Set up the speech model in Voice first" },
    });
  });

  test("a new session cancels the pending idle timer of the previous one", () => {
    const h = harness({ cleanupEnabled: false });
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
    const first = h.id();
    h.dictation.onHelperEvent({
      type: "capture.started",
      id: first,
      startMs: 40,
      relayMs: null,
      asrState: null,
    });
    vi.advanceTimersByTime(800);
    h.dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
    h.dictation.onHelperEvent({
      type: "transcript",
      id: first,
      text: "one",
      audioMs: 800,
      asrMs: 100,
      speechMs: 600,
      relayMs: null,
      target: null,
    });
    h.dictation.onHelperEvent({
      type: "insert.result",
      id: first,
      method: "paste",
      route: "forced",
      clipboardSaveMs: null,
    });
    vi.advanceTimersByTime(IDLE_AFTER_INSERTED_MS - 100);
    h.dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
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

  test("a permissions event that repeats the current state notifies no one", () => {
    const h = harness();
    const denied = { type: "permissions", microphone: "denied", accessibility: "granted" } as const;
    h.dictation.onHelperEvent(denied);
    h.dictation.onHelperEvent(denied);
    h.dictation.onHelperEvent(denied);
    expect(h.phases).toHaveLength(1);

    h.dictation.onHelperEvent({ ...denied, microphone: "granted" });
    expect(h.phases).toHaveLength(2);
    expect(h.store.state.permissions).toEqual({ microphone: "granted", accessibility: "granted" });
  });
});

describe("auto-apply after dictation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const polish = BUILT_IN_TRANSFORMS.find((item) => item.id === POLISH_ID)!;
  const hadrys: DictionaryEntry = { id: "1", phrase: "Hadryś", replacement: null };

  test("runs the transform on the transcript in dictation mode and inserts its result", async () => {
    const h = harness({ autoApply: POLISH_ID });
    const raw = "um so ask kenji about friday";
    const id = await dictate(h, raw);
    expect(h.cleans).toEqual([]);
    expect(h.transformRuns).toMatchObject([
      {
        instruction: polish.instruction,
        text: raw,
        dictation: { instructionKeepsWords: true },
        budgetMs: autoApplyBudgetMs(raw),
      },
    ]);
    expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: `Polished: ${raw}`, html: null });
    expect(h.latest()).toMatchObject({ raw, text: `Polished: ${raw}` });
    expect(h.lastTransforms).toEqual([{ name: "Polish", before: raw, after: `Polished: ${raw}` }]);

    h.dictation.onHelperEvent({
      type: "insert.result",
      id,
      method: "paste",
      route: "forced",
      clipboardSaveMs: null,
    });
    expect(h.dictated).toMatchObject([{ raw, insertedCleanup: null }]);
    expect(h.logs.at(-1)).toMatch(/^session \S+ outcome=inserted .*cleanupMs=\d+/);
  });

  test("applies the dictionary to the result, and Last transform keeps what was inserted", async () => {
    const h = harness({ autoApply: POLISH_ID, dictionary: [hadrys] });
    const id = await dictate(h, "ask hadrys");
    expect(h.transformRuns.map((r) => r.text)).toEqual(["ask hadrys"]);
    expect(h.commands.at(-1)).toEqual({
      type: "insert",
      id,
      text: "Polished: ask Hadryś",
      html: null,
    });
    // Copy result on the Transforms page must give the text that landed in the app.
    expect(h.lastTransforms).toEqual([
      { name: "Polish", before: "ask hadrys", after: "Polished: ask Hadryś" },
    ]);
  });

  test.each<[string, TransformResult | "rejects", string]>([
    ["refuses the result", { ok: false, failure: { kind: "rejected" } }, "transform rejected"],
    ["runs out of time", { ok: false, failure: { kind: "timedOut" } }, "transform timedOut"],
    [
      "finds the text too long",
      { ok: false, failure: { kind: "tooLong", maxWords: 1000 } },
      "transform tooLong",
    ],
    ["stops", "rejects", "transform failed"],
  ])(
    "inserts the transcript with the dictionary applied when the transform %s",
    async (_, transformResult, logged) => {
      const h = harness({ autoApply: POLISH_ID, transformResult, dictionary: [hadrys] });
      const id = await dictate(h, "keep hadrys");
      expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: "keep Hadryś", html: null });
      expect(h.latest()).toMatchObject({ raw: "keep hadrys", text: "keep Hadryś" });
      expect(h.lastTransforms).toEqual([]);
      // The worker's own message never reaches the log, as on the on-demand path.
      expect(h.logs).toContain(`cleanup failed: ${logged}`);
      expect(h.logs.join("\n")).not.toContain("The transform model stopped");
      expect(h.entries).toEqual([
        { message: "cleanup failed", level: "warn", attributes: { "error.type": "Error" } },
      ]);
    },
  );

  test.each<[string, Transform]>([
    [
      "a custom transform",
      {
        id: "translate" as TransformId,
        name: "Translate",
        instruction: "Translate to English.",
        shortcut: null,
      },
    ],
    ["an edited Polish", { ...polish, instruction: `${polish.instruction} Use British spelling.` }],
  ])("does not vouch that %s keeps the dictation's words", async (_, transform) => {
    const h = harness({ autoApply: transform.id, transforms: [transform] });
    await dictate(h, "ask kenji about friday");
    expect(h.transformRuns).toMatchObject([
      { instruction: transform.instruction, dictation: { instructionKeepsWords: false } },
    ]);
  });

  test("a transform that never settles is aborted after its budget and a grace, and the transcript goes in", async () => {
    const h = harness({ autoApply: POLISH_ID, transformResult: "hangs" });
    const raw = "one two three";
    const id = await dictate(h, raw);
    const budgetMs = autoApplyBudgetMs(raw);
    await vi.advanceTimersByTimeAsync(budgetMs + CLEANUP_GRACE_MS - 1);
    expect(h.transformRuns[0]!.signal.aborted).toBe(false);
    expect(h.commands.at(-1)).toEqual({ type: "capture.stop", id });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.transformRuns[0]!.signal.aborted).toBe(true);
    expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: raw, html: null });
    expect(h.logs).toContainEqual(expect.stringContaining("cleanup timed out"));
  });

  test("a dictation of only a trigger inserts the expansion without the transform", async () => {
    const expansion = "Best,\nAlex";
    const h = harness({
      autoApply: POLISH_ID,
      snippets: [{ id: "1", trigger: "sign off", expansion, expansionHtml: null, enabled: true }],
    });
    const id = await dictate(h, "Sign off.");
    expect(h.transformRuns).toEqual([]);
    expect(h.commands.at(-1)).toEqual({ type: "insert", id, text: expansion, html: null });
  });

  test.each<[string, Options]>([
    ["the language has no cleanup", { dictationLanguage: "de" }],
    ["cleanup is off", { cleanupEnabled: false }],
    ["the cleanup model is not loaded", { cleanupLoaded: false }],
  ])("the transform runs when %s", async (_, opts) => {
    const h = harness({ ...opts, autoApply: POLISH_ID });
    await dictate(h, "hallo welt");
    expect(h.transformRuns.map((r) => r.text)).toEqual(["hallo welt"]);
    expect(h.cleans).toEqual([]);
  });

  test.each<[string, Options]>([
    ["Transforms are off", { autoApply: POLISH_ID, transformsEnabled: false }],
    ["the transform model is not on disk", { autoApply: POLISH_ID, transformOnDisk: false }],
    ["no transform is set", {}],
    ["the set transform no longer exists", { autoApply: "gone" as TransformId }],
  ])("S1-mini cleans as before when %s", async (_, opts) => {
    const h = harness(opts);
    const id = release(h, 800);
    expect(h.gpu).toEqual(["busy"]);
    h.helper.transcript(id, "hey");
    await flush();
    expect(h.transformRuns).toEqual([]);
    expect(h.cleans).toEqual(["hey"]);
    expect(h.warms()).toBe(0);
  });

  test("the model is warmed once per session when the transform will run", async () => {
    const h = harness({ autoApply: POLISH_ID });
    await dictate(h, "hello");
    expect(h.warms()).toBe(1);
  });

  test("the GPU is not held for S1-mini while a transform will run", () => {
    const h = harness({ autoApply: POLISH_ID });
    release(h, 800);
    expect(h.gpu).toEqual([]);
  });

  test("the auto-apply budget grows with the input and is capped", () => {
    expect(autoApplyBudgetMs("")).toBe(AUTO_APPLY_BUDGET.base);
    expect(autoApplyBudgetMs("a b c")).toBe(AUTO_APPLY_BUDGET.base + 3 * AUTO_APPLY_BUDGET.perWord);
    expect(autoApplyBudgetMs("w ".repeat(1000))).toBe(AUTO_APPLY_BUDGET.max);
  });
});

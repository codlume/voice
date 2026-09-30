import * as SentryNode from "@sentry/node";
import { afterEach, describe, expect, test } from "vite-plus/test";

import type { DiagnosticsConsent, Outcome } from "../shared/api.ts";
import { HELPER_EXIT_MESSAGE } from "./diagnostics-scrub.ts";
import { sessionSpan, startDiagnostics, type Diagnostics } from "./diagnostics.ts";
import { createDictation, type SessionReport } from "./dictation.ts";
import { idle } from "./session.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { createStore } from "./store.ts";

const RAW = "hi anna can we move our meeting to thursday at three thirty";
const CLEANED = "Hi Anna, can we move our meeting to Thursday at 3:30?";

const timings = {
  startMs: 40,
  audioMs: 800,
  asrMs: 120,
  cleanupMs: 60,
  insertMs: 30,
  releaseToInsertMs: 215,
};

const capture = { language: "en" as const, pressedAt: 1_790_000_000_000, timings };

const report = (
  outcome: Outcome,
  over: Partial<SessionReport["capture"]> | null = {},
): SessionReport => ({
  outcome,
  finishedAt: 1_790_000_001_050,
  capture: over && { ...capture, ...over },
});

describe("sessionSpan", () => {
  test.each<[Outcome, Record<string, string>]>([
    [
      { kind: "inserted", method: "accessibility" },
      { outcome: "inserted", "insert.method": "accessibility", "dictation.language": "en" },
    ],
    [
      { kind: "inserted", method: "paste" },
      { outcome: "inserted", "insert.method": "paste", "dictation.language": "en" },
    ],
    ...(["focusChanged", "noFocusedField", "secureInput", "failed"] as const).map(
      (reason): [Outcome, Record<string, string>] => [
        { kind: "notInserted", reason },
        { outcome: "notInserted", "insert.reason": reason, "dictation.language": "en" },
      ],
    ),
    [
      { kind: "failed", message: `Transcription failed for "${RAW}"` },
      { outcome: "failed", "dictation.language": "en" },
    ],
    [{ kind: "empty" }, { outcome: "empty", "dictation.language": "en" }],
    [{ kind: "tooShort" }, { outcome: "tooShort", "dictation.language": "en" }],
  ])("%j carries exactly its outcome attributes", (outcome, attributes) => {
    const span = sessionSpan(report(outcome));
    expect(span.attributes).toEqual(attributes);
    expect(span.measurements).toEqual(timings);
    const json = JSON.stringify(span);
    expect(json).not.toContain(RAW);
    expect(json).not.toContain("anna");
    expect(json).not.toContain(CLEANED);
  });

  test("spans the press to the finish and omits what is unknown", () => {
    expect(
      sessionSpan(report({ kind: "empty" }, { language: "pl", timings: { startMs: 40 } })),
    ).toEqual({
      name: "dictation.session",
      op: "dictation.session",
      startTime: 1_790_000_000_000,
      endTime: 1_790_000_001_050,
      attributes: { outcome: "empty", "dictation.language": "pl" },
      measurements: { startMs: 40 },
    });
    expect(sessionSpan(report({ kind: "failed", message: "No model" }, null))).toEqual({
      name: "dictation.session",
      op: "dictation.session",
      startTime: 1_790_000_001_050,
      endTime: 1_790_000_001_050,
      attributes: { outcome: "failed" },
      measurements: {},
    });
  });
});

type Envelope = Parameters<ReturnType<NonNullable<SentryNode.NodeOptions["transport"]>>["send"]>[0];

function harness(initial: DiagnosticsConsent) {
  let consent = initial;
  const envelopes: Envelope[] = [];
  const diagnostics: Diagnostics = startDiagnostics({
    loadSdk: () => ({
      ...SentryNode,
      makeTransport: () => ({
        send: async (envelope) => {
          envelopes.push(envelope);
          return {};
        },
        flush: async () => true,
      }),
    }),
    dsn: "https://public@o0.ingest.sentry.io/1",
    release: "voice@0.0.1",
    environment: "test",
    tracesSampleRate: 1,
    consent: () => consent,
  });
  const store = createStore({
    updates: {
      version: "0.0.1",
      installedChannel: "stable",
      channel: "stable",
      status: { kind: "disabled", reason: "Test" },
    },
    session: idle,
    permissions: { microphone: "granted", accessibility: "granted" },
    models: { asr: { state: "ready" }, cleanup: { state: "ready" } },
    settings: { ...DEFAULT_SETTINGS, diagnostics: initial },
    microphones: { kind: "loading" },
    microphoneTest: { kind: "off" },
    last: null,
  });
  let clock = Date.now();
  const dictation = createDictation({
    store,
    send: () => {},
    cleanup: { loaded: () => true, clean: async () => CLEANED },
    onLevel: () => {},
    log: () => {},
    onSessionDone: diagnostics.sessionDone,
    now: () => clock,
  });

  async function dictate() {
    dictation.onHelperEvent({ type: "hotkey", action: "down" });
    const session = store.state.session;
    if (session.phase === "idle") throw new Error("no session");
    const { id } = session;
    dictation.onHelperEvent({ type: "capture.started", id, startMs: 40 });
    clock += 800;
    dictation.onHelperEvent({ type: "hotkey", action: "up" });
    dictation.onHelperEvent({ type: "transcript", id, text: RAW, audioMs: 800, asrMs: 120 });
    await expect.poll(() => store.state.session.phase).toBe("inserting");
    clock += 30;
    dictation.onHelperEvent({ type: "insert.result", id, method: "paste", reason: null });
    expect(store.state.session.phase).toBe("done");
    dictation.dispatch({ type: "idleTimeout", id });
  }

  async function sent() {
    await SentryNode.flush(2000);
    return envelopes.map((envelope) => JSON.stringify(envelope));
  }

  return {
    diagnostics,
    dictate,
    sent,
    setConsent: (next: DiagnosticsConsent) => {
      consent = next;
    },
  };
}

describe("startDiagnostics consent", () => {
  afterEach(async () => {
    await SentryNode.close();
  });

  test.each(["unanswered", "off"] as const)("%s sends nothing", async (consent) => {
    const h = harness(consent);
    await h.dictate();
    h.diagnostics.helperExited({ code: 3, signal: null });
    SentryNode.captureException(new Error(RAW));
    expect(SentryNode.isInitialized()).toBe(false);
    expect(await h.sent()).toEqual([]);
  });

  test("on sends one scrubbed session transaction", async () => {
    const h = harness("on");
    await h.dictate();
    const sent = await h.sent();
    expect(sent).toHaveLength(1);
    const [envelope] = sent;
    expect(envelope).toContain('"transaction":"dictation.session"');
    expect(envelope).toContain('"insert.method":"paste"');
    expect(envelope).toContain('"asrMs":{"value":120,"unit":"millisecond"}');
    for (const text of [RAW, CLEANED, "anna", "Anna"]) expect(envelope).not.toContain(text);
  });

  test("on reports each kind of helper exit once, by code only", async () => {
    const h = harness("on");
    h.diagnostics.helperExited({ code: 3, signal: null });
    h.diagnostics.helperExited({ code: 3, signal: null });
    h.diagnostics.helperExited({ code: null, signal: "SIGKILL" });
    h.diagnostics.helperExited({ spawnError: "ENOENT" });
    h.diagnostics.helperExited({ spawnError: "ENOENT" });
    const sent = await h.sent();
    expect(sent).toHaveLength(3);
    expect(sent[0]).toContain(`"message":"${HELPER_EXIT_MESSAGE}"`);
    expect(sent.map((envelope) => /"tags":(\{[^}]*\})/.exec(envelope)?.[1])).toEqual([
      '{"helper.exit_code":3}',
      '{"helper.signal":"SIGKILL"}',
      '{"helper.error":"ENOENT"}',
    ]);
  });

  test("on sends a crash event without its dump or any other attachment", async () => {
    const h = harness("on");
    SentryNode.captureEvent(
      { level: "fatal", platform: "native", tags: { "event.process": "browser" } },
      {
        attachments: [
          {
            filename: "crash.dmp",
            data: `HOME=/Users/someone ${RAW}`,
            attachmentType: "event.minidump",
          },
        ],
      },
    );
    const sent = await h.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('"level":"fatal"');
    expect(sent[0]).not.toContain('"type":"attachment"');
    for (const text of ["crash.dmp", "someone", RAW]) expect(sent[0]).not.toContain(text);
  });

  test("turning consent off at runtime stops sending at once", async () => {
    const h = harness("on");
    h.setConsent("off");
    await h.dictate();
    h.diagnostics.helperExited({ spawnError: "ENOENT" });
    // Errors from SDK integrations bypass Voice's reporters; the transport gate still holds them.
    SentryNode.captureException(new Error(RAW));
    expect(await h.sent()).toEqual([]);
  });
});

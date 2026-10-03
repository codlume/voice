import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

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
type EnvelopeItem = Envelope[1][number];

const DSN = "https://public@o0.ingest.sentry.io/1";

function crashDumps() {
  const dir = mkdtempSync(NodePath.join(tmpdir(), "voice-crash-dumps-"));
  for (const name of ["completed", "pending"]) mkdirSync(NodePath.join(dir, name));
  return dir;
}

function harness(initial: DiagnosticsConsent, dsn = DSN, tracesSampleRate = 1) {
  let consent = initial;
  const envelopes: Envelope[] = [];
  const crashDumpsDir = crashDumps();
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
    dsn,
    release: "voice@0.0.1",
    environment: "test",
    tracesSampleRate,
    consent: () => consent,
    crashDumpsDir,
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
    loginItem: "off",
    models: { asr: { state: "ready" }, cleanup: { state: "ready" } },
    settings: { ...DEFAULT_SETTINGS, diagnostics: initial },
    microphones: { kind: "loading" },
    microphoneTest: { kind: "off" },
    account: { kind: "signedOut" },
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
    return id;
  }

  async function sent() {
    await SentryNode.flush(2000);
    return envelopes.map((envelope) => JSON.stringify(envelope));
  }

  async function items(type: EnvelopeItem[0]["type"]) {
    await SentryNode.flush(2000);
    return envelopes.flatMap(([, list]) => list.filter(([header]) => header.type === type));
  }

  return {
    diagnostics,
    crashDumpsDir,
    dictate,
    sent,
    items,
    setConsent: (next: DiagnosticsConsent) => {
      consent = next;
    },
  };
}

describe("startDiagnostics consent", () => {
  afterEach(async () => {
    await SentryNode.close();
  });

  test("off sends nothing", async () => {
    const h = harness("off");
    await h.dictate();
    h.diagnostics.helperExited({ code: 3, signal: null });
    h.diagnostics.log({ message: "dock update failed", level: "warn" });
    SentryNode.captureException(new Error(RAW));
    expect(SentryNode.isInitialized()).toBe(false);
    expect(await h.sent()).toEqual([]);
  });

  test.each([
    ["off", DSN],
    ["on", ""],
  ] as const)(
    "%s with DSN %j stays inactive and removes leftover crash dumps",
    async (consent, dsn) => {
      const h = harness(consent, dsn);
      expect(h.diagnostics.active).toBe(false);
      await expect.poll(() => existsSync(NodePath.join(h.crashDumpsDir, "completed"))).toBe(false);
      expect(existsSync(NodePath.join(h.crashDumpsDir, "pending"))).toBe(false);
    },
  );

  test("on sends one scrubbed session transaction", async () => {
    const h = harness("on");
    expect(h.diagnostics.active).toBe(true);
    await h.dictate();
    const sent = (await h.items("transaction")).map((item) => JSON.stringify(item));
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
    const sent = (await h.items("event")).map((item) => JSON.stringify(item));
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

  test("on logs every helper exit, by code only", async () => {
    const h = harness("on");
    h.diagnostics.helperExited({ code: 3, signal: null });
    h.diagnostics.helperExited({ code: 3, signal: null });
    h.diagnostics.helperExited({ code: null, signal: "SIGKILL" });
    const logs = await h.items("log");
    expect(logs).toHaveLength(1);
    const json = JSON.stringify(logs);
    expect(json).toContain('"item_count":3');
    expect(json.match(/"body":"helper exited"/g)).toHaveLength(3);
    expect(json).toContain('"helper.exit_code":{"value":3,"type":"integer"}');
    expect(json).toContain('"helper.signal":{"value":"SIGKILL","type":"string"}');
  });

  test("on sends one log per session, tied to its transaction and free of its text", async () => {
    const h = harness("on");
    SentryNode.setUser({ id: "someone", email: "anna@example.com" });
    SentryNode.getCurrentScope().setAttributes({ "app.home": "/Users/someone/Voice" });
    const id = await h.dictate();
    // Logs from the renderer or any other SDK caller reach the transport with free-form bodies.
    SentryNode.logger.info(RAW);
    SentryNode.logger.warn(SentryNode.logger.fmt`cleanup failed for ${RAW}`);
    const transactions = JSON.stringify(await h.items("transaction"));
    const traceId = /"trace_id":"([0-9a-f]{32})"/.exec(transactions)?.[1];
    expect(traceId).toBeDefined();
    const logs = await h.items("log");
    expect(logs).toEqual([
      [
        { type: "log", item_count: 1, content_type: "application/vnd.sentry.items.log+json" },
        {
          version: 2,
          items: [
            {
              timestamp: expect.any(Number),
              level: "info",
              body: "dictation session finished",
              trace_id: traceId,
              severity_number: 9,
              attributes: {
                outcome: { value: "inserted", type: "string" },
                "insert.method": { value: "paste", type: "string" },
                "dictation.language": { value: "en", type: "string" },
                startMs: { value: 40, type: "integer" },
                audioMs: { value: 800, type: "integer" },
                asrMs: { value: 120, type: "integer" },
                cleanupMs: { value: 0, type: "integer" },
                insertMs: { value: 30, type: "integer" },
                releaseToInsertMs: { value: 30, type: "integer" },
                "sentry.release": { value: "voice@0.0.1", type: "string" },
                "sentry.environment": { value: "test", type: "string" },
                "sentry.sdk.name": { value: "sentry.javascript.node", type: "string" },
                "sentry.sdk.version": { value: SentryNode.SDK_VERSION, type: "string" },
                "sentry.timestamp.sequence": { value: expect.any(Number), type: "integer" },
              },
            },
          ],
        },
      ],
    ]);
    const json = JSON.stringify(await h.sent());
    for (const text of [RAW, CLEANED, id.slice(0, 8), "someone", "server.address", "user."]) {
      expect(json).not.toContain(text);
    }
  });

  test("an unsampled session still sends its log", async () => {
    const h = harness("on", DSN, 0);
    await h.dictate();
    expect(await h.items("transaction")).toEqual([]);
    const logs = JSON.stringify(await h.items("log"));
    expect(logs).toContain('"body":"dictation session finished"');
    expect(logs).toMatch(/"trace_id":"[0-9a-f]{32}"/);
  });

  test("an envelope whose logs are all dropped is not sent", async () => {
    const h = harness("on");
    SentryNode.logger.error(RAW);
    expect(await h.sent()).toEqual([]);
  });

  test("an envelope item that is neither an event, a transaction, nor a log is not sent", async () => {
    const h = harness("on");
    SentryNode.setUser({ id: "someone" });
    SentryNode.startSession();
    SentryNode.captureSession(true);
    expect(await h.items("session")).toEqual([]);
    expect((await h.sent()).join()).not.toContain("someone");
  });

  test("turning consent off at runtime stops sending at once", async () => {
    const h = harness("on");
    h.setConsent("off");
    await h.dictate();
    h.diagnostics.helperExited({ spawnError: "ENOENT" });
    h.diagnostics.log({ message: "dock update failed", level: "warn" });
    // Errors from SDK integrations bypass Voice's reporters; the transport gate still holds them.
    SentryNode.captureException(new Error(RAW));
    expect(await h.sent()).toEqual([]);
  });
});

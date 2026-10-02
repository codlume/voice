import type { Event } from "@sentry/electron/main";
import { describe, expect, test } from "vite-plus/test";

import { HELPER_EXIT_MESSAGE, scrubEvent, scrubLogs } from "./diagnostics-scrub.ts";

const DICTATION =
  "Hi Anna, can we move our meeting to Thursday at three thirty? https://example.com/anna 4242";
const SECRETS = ["Anna", "anna", "Thursday", "example.com", "4242", "someone"];

const home = "/Users/someone/Library/Application Support/Voice";

const errorEvent: Event = {
  event_id: "0123456789abcdef0123456789abcdef",
  timestamp: 1_790_000_000.5,
  platform: "node",
  level: "error",
  release: "voice@0.14.0",
  environment: "stable",
  server_name: "someones-macbook",
  message: DICTATION,
  logentry: { message: DICTATION, params: [DICTATION] },
  transaction: DICTATION,
  sdk: {
    name: "sentry.javascript.electron",
    version: "7.20.0",
    integrations: ["Anna"],
    packages: [{ name: "npm:@sentry/electron", version: "7.20.0" }],
  },
  exception: {
    values: [
      {
        type: "TypeError",
        value: `Cannot read properties of undefined (reading '${DICTATION}')`,
        mechanism: {
          type: "auto.node.onuncaughtexception",
          handled: false,
          data: { text: DICTATION },
        },
        stacktrace: {
          frames: [
            {
              filename: `${home}/app.asar/dist-electron/main.cjs`,
              abs_path: `file://${home}/app.asar/dist-electron/main.cjs`,
              function: "insertText",
              module: "main",
              lineno: 120,
              colno: 7,
              in_app: true,
              context_line: `  send({ text: "${DICTATION}" })`,
              pre_context: [DICTATION],
              post_context: [DICTATION],
              vars: { text: DICTATION, target: "Mail" },
            },
          ],
        },
      },
    ],
  },
  breadcrumbs: [{ message: DICTATION, category: "console" }],
  extra: { transcript: DICTATION },
  user: { id: "someone", email: "anna@example.com", ip_address: "10.0.0.1" },
  request: { url: "https://example.com/anna?q=4242", headers: { cookie: "Anna" } },
  modules: { anna: "1.0.0" },
  fingerprint: [DICTATION],
  tags: {
    outcome: "inserted",
    "event.process": "browser",
    "target.app": "Mail",
    transcript: DICTATION,
    "insert.method": { nested: DICTATION } as unknown as string,
  },
  contexts: {
    os: { name: "macOS", version: "26.0", kernel_version: "someone" },
    device: { model: "Mac16,1", memory_size: 4242 },
    app: { app_name: "Voice", app_start_time: DICTATION },
    culture: { locale: "en-US", timezone: "Europe/Warsaw" },
    trace: {
      trace_id: "11111111111111111111111111111111",
      span_id: "2222222222222222",
      data: { text: DICTATION },
    },
  },
  debug_meta: {
    images: [
      {
        type: "sourcemap",
        code_file: `file://${home}/app.asar/dist-electron/main.cjs`,
        debug_id: "8e1c1b2e-6b0f-4b1f-9a9b-3f0c2d7a1e11",
      },
      {
        type: "macho",
        debug_id: "5b2f4c1e-0000-4000-8000-000000004242",
        image_addr: "0x100000000",
        code_file: `${home}/Voice.app/Contents/MacOS/Voice`,
      },
    ],
  },
  threads: { values: [{ id: 1, name: DICTATION }] },
};

const transactionEvent: Event = {
  type: "transaction",
  event_id: "abcdefabcdefabcdefabcdefabcdefab",
  transaction: "dictation.session",
  start_timestamp: 1_790_000_000,
  timestamp: 1_790_000_001.2,
  platform: "node",
  release: "voice@0.14.0",
  environment: "stable",
  contexts: {
    trace: {
      trace_id: "11111111111111111111111111111111",
      span_id: "3333333333333333",
      op: "dictation.session",
      origin: "manual",
      status: "ok",
      data: {
        outcome: "inserted",
        "insert.method": "paste",
        "dictation.language": "en",
        "sentry.op": "dictation.session",
        "sentry.origin": "manual",
        "sentry.source": "custom",
        "sentry.sample_rate": 1,
        text: DICTATION,
        "target.app": "Mail",
      },
    },
    otel: { resource: { "host.name": "someones-macbook", "process.command": home } },
  },
  spans: [
    {
      span_id: "4444444444444444",
      trace_id: "11111111111111111111111111111111",
      start_timestamp: 1_790_000_000,
      data: { text: DICTATION },
      description: DICTATION,
      origin: "manual",
    },
  ],
  measurements: {
    asrMs: { value: 120, unit: "millisecond" },
    insertMs: { value: 30, unit: "millisecond" },
    transcriptChars: { value: 4242, unit: "none" },
    startMs: { value: Number.NaN, unit: "millisecond" },
  },
};

const leaks = (json: string) => SECRETS.filter((secret) => json.includes(secret));

describe("scrubEvent", () => {
  test("a main-process error keeps only its shape, frames, and allowed tags", () => {
    const scrubbed = scrubEvent(errorEvent);
    expect(leaks(JSON.stringify(scrubbed))).toEqual([]);
    expect(scrubbed).toEqual({
      event_id: "0123456789abcdef0123456789abcdef",
      timestamp: 1_790_000_000.5,
      platform: "node",
      level: "error",
      release: "voice@0.14.0",
      environment: "stable",
      sdk: { name: "sentry.javascript.electron", version: "7.20.0" },
      exception: {
        values: [
          {
            type: "TypeError",
            mechanism: { type: "auto.node.onuncaughtexception", handled: false },
            stacktrace: {
              frames: [
                {
                  filename:
                    "/Users/<redacted>/Library/Application Support/Voice/app.asar/dist-electron/main.cjs",
                  abs_path:
                    "file:///Users/<redacted>/Library/Application Support/Voice/app.asar/dist-electron/main.cjs",
                  function: "insertText",
                  module: "main",
                  lineno: 120,
                  colno: 7,
                  in_app: true,
                },
              ],
            },
          },
        ],
      },
      debug_meta: {
        images: [
          {
            type: "sourcemap",
            code_file:
              "file:///Users/<redacted>/Library/Application Support/Voice/app.asar/dist-electron/main.cjs",
            debug_id: "8e1c1b2e-6b0f-4b1f-9a9b-3f0c2d7a1e11",
          },
        ],
      },
      tags: { outcome: "inserted", "event.process": "browser" },
      contexts: {
        trace: {
          trace_id: "11111111111111111111111111111111",
          span_id: "2222222222222222",
          data: {},
        },
      },
    });
  });

  test("a session transaction keeps its name, allowed attributes, and timing measurements", () => {
    const scrubbed = scrubEvent(transactionEvent);
    expect(leaks(JSON.stringify(scrubbed))).toEqual([]);
    expect(scrubbed).toEqual({
      type: "transaction",
      event_id: "abcdefabcdefabcdefabcdefabcdefab",
      transaction: "dictation.session",
      start_timestamp: 1_790_000_000,
      timestamp: 1_790_000_001.2,
      platform: "node",
      release: "voice@0.14.0",
      environment: "stable",
      contexts: {
        trace: {
          trace_id: "11111111111111111111111111111111",
          span_id: "3333333333333333",
          op: "dictation.session",
          origin: "manual",
          status: "ok",
          data: {
            outcome: "inserted",
            "insert.method": "paste",
            "dictation.language": "en",
            "sentry.op": "dictation.session",
            "sentry.origin": "manual",
            "sentry.source": "custom",
            "sentry.sample_rate": 1,
          },
        },
      },
      measurements: {
        asrMs: { value: 120, unit: "millisecond" },
        insertMs: { value: 30, unit: "millisecond" },
      },
    });
  });

  test("keeps only the helper-exit message and drops any other message", () => {
    const helperExit = scrubEvent({
      message: HELPER_EXIT_MESSAGE,
      level: "error",
      tags: { "helper.exit_code": 3 },
    });
    expect(helperExit).toEqual({
      message: HELPER_EXIT_MESSAGE,
      level: "error",
      tags: { "helper.exit_code": 3 },
    });
    expect(scrubEvent({ message: DICTATION, level: "info" })).toEqual({ level: "info" });
  });

  test("builds a new event and leaves the original untouched", () => {
    const before = structuredClone(errorEvent);
    scrubEvent(errorEvent);
    expect(errorEvent).toEqual(before);
  });
});

const sdkAttributes = {
  "sentry.release": { value: "voice@0.14.0", type: "string" },
  "sentry.environment": { value: "stable", type: "string" },
  "sentry.sdk.name": { value: "sentry.javascript.electron", type: "string" },
  "sentry.sdk.version": { value: "7.20.0", type: "string" },
  "sentry.timestamp.sequence": { value: 0, type: "integer" },
};

const logPayload = {
  version: 2,
  items: [
    {
      timestamp: 1_790_000_001.05,
      level: "info",
      body: "dictation session finished",
      trace_id: "11111111111111111111111111111111",
      severity_number: 9,
      attributes: {
        outcome: { value: "inserted", type: "string" },
        asrMs: { value: 120, type: "integer" },
        insertMs: { value: 30.5, type: "double" },
        "insert.method": { value: { nested: DICTATION }, type: "string" },
        audioMs: { value: "4242", type: "integer" },
        startMs: { value: Number.NaN, type: "double" },
        ...sdkAttributes,
        "user.email": { value: "anna@example.com", type: "string" },
        "user.id": { value: "someone", type: "string" },
        "server.address": { value: "someones-macbook", type: "string" },
        "electron.process": { value: "browser", type: "string" },
        "os.name": { value: "macOS", type: "string" },
        "app.home": { value: home, type: "string" },
        "sentry.trace.parent_span_id": { value: "3333333333333333", type: "string" },
        "sentry.message.template": { value: "finished %s", type: "string" },
        "sentry.message.parameter.0": { value: DICTATION, type: "string" },
        transcript: { value: DICTATION, type: "string" },
      },
      extra: DICTATION,
    },
    {
      timestamp: 1_790_000_002,
      level: "error",
      body: "helper exited",
      attributes: {
        "helper.error": { value: `spawn ${home}/voice-helper ENOENT`, type: "string" },
        "helper.signal": { value: ["SIGKILL", DICTATION], type: "array" },
      },
    },
    {
      timestamp: 1_790_000_003,
      level: "info",
      body: "hotkey tap installed",
      attributes: { "helper.protocol_version": { value: 4242, type: "integer" } },
    },
    { timestamp: 1_790_000_004, level: "info", body: DICTATION, attributes: sdkAttributes },
    { timestamp: 1_790_000_004, level: "info", body: "toString" },
    { timestamp: 1_790_000_004, level: "verbose", body: "helper ready" },
    { level: "info", body: "helper ready" },
    "Anna",
  ],
};

describe("scrubLogs", () => {
  test("keeps only allowlisted messages and each one's attributes", () => {
    const scrubbed = scrubLogs(logPayload);
    expect(leaks(JSON.stringify(scrubbed))).toEqual([]);
    expect(scrubbed).toEqual({
      version: 2,
      items: [
        {
          timestamp: 1_790_000_001.05,
          level: "info",
          body: "dictation session finished",
          trace_id: "11111111111111111111111111111111",
          severity_number: 9,
          attributes: {
            outcome: { value: "inserted", type: "string" },
            asrMs: { value: 120, type: "integer" },
            insertMs: { value: 30.5, type: "double" },
            ...sdkAttributes,
          },
        },
        {
          timestamp: 1_790_000_002,
          level: "error",
          body: "helper exited",
          attributes: {
            "helper.error": {
              value:
                "spawn /Users/<redacted>/Library/Application Support/Voice/voice-helper ENOENT",
              type: "string",
            },
          },
        },
        { timestamp: 1_790_000_003, level: "info", body: "hotkey tap installed", attributes: {} },
      ],
    });
  });

  test("a payload that is not a log container keeps nothing", () => {
    expect(scrubLogs(DICTATION)).toEqual({ items: [] });
    expect(scrubLogs({ items: { body: "helper ready" } })).toEqual({ items: [] });
  });

  test("builds new logs and leaves the original untouched", () => {
    const before = structuredClone(logPayload);
    scrubLogs(logPayload);
    expect(logPayload).toEqual(before);
  });
});

import type { Event } from "@sentry/electron/main";
import { describe, expect, test } from "vite-plus/test";

import { HELPER_EXIT_MESSAGE, scrubEvent } from "./diagnostics-scrub.ts";

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

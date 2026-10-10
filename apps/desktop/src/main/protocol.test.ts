import { describe, expect, test } from "vite-plus/test";

import { parseHelperEvent } from "./protocol.ts";

const line = (value: unknown) => JSON.stringify(value);

describe("parseHelperEvent", () => {
  test("accepts every event variant with exactly the typed fields", () => {
    const events = [
      { type: "ready", version: 7 },
      { type: "hotkey", action: "down" },
      { type: "capture.started", id: "a", startMs: 42 },
      { type: "capture.level", id: "a", level: 0.5 },
      { type: "capture.failed", id: "a", message: "denied" },
      { type: "capture.cancelled", id: "a" },
      { type: "capture.stopped", id: "a", reason: "deviceChanged" },
      { type: "capture.stopped", id: "a", reason: "maxDuration" },
      { type: "microphone.test.started", id: "t" },
      { type: "microphone.test.level", id: "t", level: 0.3 },
      { type: "microphone.test.ended", id: "t" },
      { type: "microphone.test.failed", id: "t", message: "Finish dictating, then test again." },
      { type: "transcript", id: "a", text: "hi", audioMs: 1200, asrMs: 300 },
      { type: "transcript.failed", id: "a", message: "no model" },
      { type: "insert.result", id: "a", method: "accessibility", reason: null },
      { type: "insert.result", id: "a", method: "none", reason: "focusChanged" },
      { type: "permissions", microphone: "granted", accessibility: "denied" },
      { type: "asr.status", state: "ready", message: null },
      { type: "log", level: "info", message: "hello" },
    ];
    for (const event of events) expect(parseHelperEvent(line(event))).toEqual(event);
  });

  test("drops unknown fields and fills optional ones", () => {
    expect(
      parseHelperEvent(line({ type: "insert.result", id: "a", method: "paste", extra: 1 })),
    ).toEqual({
      type: "insert.result",
      id: "a",
      method: "paste",
      reason: null,
    });
    expect(
      parseHelperEvent(line({ type: "asr.status", state: "failed", message: "boom" })),
    ).toEqual({
      type: "asr.status",
      state: "failed",
      message: "boom",
    });
  });

  test("accepts method none without a reason, as the spec marks reason optional", () => {
    expect(parseHelperEvent(line({ type: "insert.result", id: "a", method: "none" }))).toEqual({
      type: "insert.result",
      id: "a",
      method: "none",
      reason: null,
    });
    expect(
      parseHelperEvent(line({ type: "capture.failed", id: "a", reason: "novel", message: "m" })),
    ).toEqual({ type: "capture.failed", id: "a", message: "m" });
  });

  test("accepts a busy capture failure, which the helper reports while it still holds a capture", () => {
    expect(
      parseHelperEvent(
        line({ type: "capture.failed", id: "a", reason: "busy", message: "still capturing" }),
      ),
    ).toEqual({ type: "capture.failed", id: "a", message: "still capturing" });
  });

  test("clamps levels into 0..1", () => {
    expect(parseHelperEvent(line({ type: "capture.level", id: "a", level: 3 }))).toEqual({
      type: "capture.level",
      id: "a",
      level: 1,
    });
    expect(parseHelperEvent(line({ type: "capture.level", id: "a", level: -3 }))).toEqual({
      type: "capture.level",
      id: "a",
      level: 0,
    });
    expect(parseHelperEvent(line({ type: "microphone.test.level", id: "t", level: 2 }))).toEqual({
      type: "microphone.test.level",
      id: "t",
      level: 1,
    });
  });

  test.each([undefined, null, 42, {}, [], "unknown"])(
    "normalizes an unsupported insertion reason %j to null",
    (reason) => {
      expect(
        parseHelperEvent(line({ type: "insert.result", id: "a", method: "none", reason })),
      ).toEqual({ type: "insert.result", id: "a", method: "none", reason: null });
    },
  );

  test.each([undefined, null, 42, {}, []])(
    "normalizes a missing or invalid ASR message %j to null",
    (message) => {
      expect(parseHelperEvent(line({ type: "asr.status", state: "ready", message }))).toEqual({
        type: "asr.status",
        state: "ready",
        message: null,
      });
    },
  );

  test.each([
    '{"type":"ready","version":1e400}',
    '{"type":"capture.started","id":"a","startMs":1e400}',
    '{"type":"capture.level","id":"a","level":-1e400}',
    '{"type":"transcript","id":"a","text":"hi","audioMs":1e400,"asrMs":1}',
    '{"type":"transcript","id":"a","text":"hi","audioMs":1,"asrMs":1e400}',
  ])("rejects non-finite numbers in valid JSON %s", (input) => {
    expect(parseHelperEvent(input)).toBeNull();
  });

  test.each([
    ["not json", "{nope"],
    ["an array", "[1]"],
    ["an unknown type", line({ type: "capture.exploded", id: "a" })],
    ["a missing id", line({ type: "capture.started", startMs: 1 })],
    ["a test failure without a message", line({ type: "microphone.test.failed", id: "t" })],
    ["a wrong field type", line({ type: "transcript", id: "a", text: 5, audioMs: 1, asrMs: 1 })],
    ["an unknown enum value", line({ type: "hotkey", action: "sideways" })],
    ["a NaN number", '{"type":"capture.level","id":"a","level":NaN}'],
    [
      "an unknown permission state",
      line({ type: "permissions", microphone: "maybe", accessibility: "granted" }),
    ],
  ])("rejects %s", (_name, input) => {
    expect(parseHelperEvent(input)).toBeNull();
  });
});

describe("microphone catalog", () => {
  test("decodes input devices and the system default", () => {
    const event = {
      type: "microphones.changed",
      devices: [{ uid: "usb", name: "USB Microphone" }],
      defaultUid: "usb",
    };
    expect(parseHelperEvent(JSON.stringify(event))).toEqual(event);
    expect(parseHelperEvent(JSON.stringify({ ...event, devices: [], defaultUid: null }))).toEqual({
      ...event,
      devices: [],
      defaultUid: null,
    });
  });

  test.each([
    { devices: [{}], defaultUid: null },
    { devices: [{ uid: "", name: "USB" }], defaultUid: null },
    { devices: [], defaultUid: 4 },
    { devices: [] },
  ])("rejects a malformed catalog %j", (fields) =>
    expect(parseHelperEvent(JSON.stringify({ type: "microphones.changed", ...fields }))).toBeNull(),
  );

  test("decodes enumeration failure", () => {
    const event = { type: "microphones.unavailable", message: "Unavailable" };
    expect(parseHelperEvent(JSON.stringify(event))).toEqual(event);
  });
});

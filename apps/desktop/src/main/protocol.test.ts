import { describe, expect, test } from "vite-plus/test";

import { parseHelperEvent } from "./protocol.ts";

const line = (value: unknown) => JSON.stringify(value);

describe("parseHelperEvent", () => {
  test("accepts every event variant with exactly the typed fields", () => {
    const events = [
      { type: "ready", version: 3 },
      { type: "hotkey", action: "down" },
      { type: "capture.started", id: "a", startMs: 42 },
      { type: "capture.level", id: "a", level: 0.5 },
      { type: "capture.failed", id: "a", message: "denied" },
      { type: "capture.cancelled", id: "a" },
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
  });

  test.each([
    ["not json", "{nope"],
    ["an array", "[1]"],
    ["an unknown type", line({ type: "capture.exploded", id: "a" })],
    ["a missing id", line({ type: "capture.started", startMs: 1 })],
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

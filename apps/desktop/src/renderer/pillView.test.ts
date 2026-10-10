import { describe, expect, test } from "vite-plus/test";

import type { Outcome } from "../shared/api.ts";
import { BAR_COUNT, MIN_BAR_SCALE, barScales, pillView, smoothLevel } from "./pillView.ts";

const done = (outcome: Outcome, copyToClipboard = false) =>
  pillView({ kind: "done", outcome }, { copyToClipboard });

describe("pillView", () => {
  test("shows listening only for the listening phase", () => {
    const off = { copyToClipboard: false };
    expect(pillView({ kind: "listening" }, off)).toEqual({ kind: "listening" });
    expect(pillView({ kind: "processing", overdue: false }, off)).toEqual({ kind: "processing" });
    expect(pillView({ kind: "processing", overdue: true }, off)).toEqual({
      kind: "message",
      text: "Still transcribing",
    });
    expect(pillView({ kind: "idle" }, off)).toEqual({ kind: "idle" });
  });

  test("shows the check only when text was inserted, and says so when it went through paste", () => {
    expect(done({ kind: "inserted", method: "accessibility" })).toEqual({
      kind: "inserted",
      method: "accessibility",
    });
    expect(done({ kind: "inserted", method: "paste" })).toEqual({
      kind: "inserted",
      method: "paste",
    });
    expect(done({ kind: "notInserted", reason: "failed" }).kind).not.toBe("inserted");
  });

  test.each<[Outcome, string]>([
    [{ kind: "empty" }, "Nothing heard"],
    [{ kind: "tooShort" }, "Too short. Hold to talk"],
    [{ kind: "notInserted", reason: "focusChanged" }, "Not inserted. Focus changed"],
    [{ kind: "notInserted", reason: "noFocusedField" }, "Not inserted. No text field"],
    [{ kind: "notInserted", reason: "secureInput" }, "Not inserted. Secure field"],
    [{ kind: "notInserted", reason: "failed" }, "Not inserted. Copy it from Voice"],
    [
      { kind: "failed", message: "Set up the speech model in Voice first" },
      "Set up the speech model in Voice first",
    ],
  ])("%j reads %s", (outcome, text) => {
    expect(done(outcome)).toEqual({ kind: "message", text });
  });

  test.each<[Outcome, string]>([
    [{ kind: "notInserted", reason: "focusChanged" }, "Focus changed. Copied to clipboard"],
    [{ kind: "notInserted", reason: "noFocusedField" }, "No text field. Copied to clipboard"],
    [{ kind: "notInserted", reason: "secureInput" }, "Secure field. Copied to clipboard"],
    [{ kind: "notInserted", reason: "failed" }, "Not inserted. Copied to clipboard"],
  ])("with copy to clipboard on, %j reads %s", (outcome, text) => {
    expect(done(outcome, true)).toEqual({ kind: "message", text });
  });

  test.each<Outcome>([
    { kind: "empty" },
    { kind: "tooShort" },
    { kind: "failed", message: "Set up the speech model in Voice first" },
  ])("with copy to clipboard on, %j never claims a copy", (outcome) => {
    expect(done(outcome, true)).toEqual(done(outcome));
  });
});

describe("level smoothing", () => {
  test("converges on a steady level and never leaves 0..1", () => {
    let level = 0;
    for (let i = 0; i < 30; i++) level = smoothLevel(level, 0.7);
    expect(level).toBeCloseTo(0.7, 3);
    expect(smoothLevel(0, 5)).toBeLessThanOrEqual(1);
    expect(smoothLevel(0.5, -1)).toBeGreaterThanOrEqual(0);
  });

  test("rises faster than it falls", () => {
    const rise = smoothLevel(0.2, 0.8) - 0.2;
    const fall = 0.8 - smoothLevel(0.8, 0.2);
    expect(rise).toBeGreaterThan(fall);
  });
});

describe("barScales", () => {
  test("silence rests every bar at the floor", () => {
    expect(barScales(0, 7)).toEqual(Array.from({ length: BAR_COUNT }, () => MIN_BAR_SCALE));
  });

  test("speech lifts the center above the edges and stays within the bar", () => {
    const scales = barScales(1, 0);
    const middle = scales[(BAR_COUNT - 1) / 2]!;
    expect(middle).toBeGreaterThan(scales[0]!);
    expect(middle).toBeGreaterThan(scales[BAR_COUNT - 1]!);
    for (const scale of scales) expect(scale).toBeLessThanOrEqual(1);
  });

  test("a steady level still moves between ticks", () => {
    expect(barScales(0.6, 1)).not.toEqual(barScales(0.6, 2));
  });
});

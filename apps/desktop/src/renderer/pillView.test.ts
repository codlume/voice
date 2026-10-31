import { describe, expect, test } from "vite-plus/test";

import type { InsertFailure, Outcome, PillState, TransformOutcome } from "../shared/api.ts";
import type { PillMeeting } from "../shared/meetings.ts";
import {
  BAR_COUNT,
  MIN_BAR_SCALE,
  barScales,
  flowBarView,
  pillView,
  smoothLevel,
  ticks,
} from "./pillView.ts";

const done = (outcome: Outcome) => pillView({ kind: "done", outcome });
const transformDone = (outcome: TransformOutcome) => pillView({ kind: "transformDone", outcome });
const kept = (reason: InsertFailure, copied: boolean): Outcome => ({
  kind: "notInserted",
  reason,
  copied,
});

describe("pillView", () => {
  test("shows listening only for the listening phase", () => {
    expect(pillView({ kind: "listening" })).toEqual({ kind: "listening" });
    expect(pillView({ kind: "processing", overdue: false })).toEqual({ kind: "processing" });
    expect(pillView({ kind: "processing", overdue: true })).toEqual({
      kind: "message",
      text: "Still transcribing",
    });
    expect(pillView({ kind: "idle" })).toEqual({ kind: "idle" });
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
    expect(done({ kind: "notInserted", reason: "failed", copied: true }).kind).not.toBe("inserted");
  });

  test.each<[Outcome, string]>([
    [{ kind: "empty" }, "Nothing heard"],
    [{ kind: "tooShort" }, "Too short. Hold to talk"],
    [kept("focusChanged", false), "Not inserted. Focus changed"],
    [kept("noFocusedField", false), "Not inserted. No text field"],
    [kept("secureInput", false), "Not inserted. Secure field"],
    [kept("selectionChanged", false), "Not inserted. Text changed"],
    [kept("failed", false), "Not inserted. Copy it from Voice"],
    [
      { kind: "failed", message: "Set up the speech model in Voice first" },
      "Set up the speech model in Voice first",
    ],
  ])("%j reads %s", (outcome, text) => {
    expect(done(outcome)).toEqual({ kind: "message", text });
  });

  test.each<[Outcome, string]>([
    [kept("focusChanged", true), "Focus changed. Copied to clipboard"],
    [kept("noFocusedField", true), "No text field. Copied to clipboard"],
    [kept("secureInput", true), "Secure field. Copied to clipboard"],
    [kept("selectionChanged", true), "Text changed. Copied to clipboard"],
    [kept("failed", true), "Not inserted. Copied to clipboard"],
  ])("once copied, %j reads %s", (outcome, text) => {
    expect(done(outcome)).toEqual({ kind: "message", text });
  });
});

describe("pillView for transforms", () => {
  test("shows dots while working and names the load when the model is not ready", () => {
    expect(pillView({ kind: "transforming", loading: false })).toEqual({ kind: "processing" });
    expect(pillView({ kind: "transforming", loading: true })).toEqual({
      kind: "message",
      text: "Loading model",
    });
  });

  test("shows the check only when the result replaced the text", () => {
    expect(transformDone({ kind: "inserted", method: "accessibility" })).toEqual({
      kind: "inserted",
      method: "accessibility",
    });
    expect(transformDone({ kind: "inserted", method: "paste" })).toEqual({
      kind: "inserted",
      method: "paste",
    });
    expect(transformDone({ kind: "notInserted", reason: "failed" }).kind).not.toBe("inserted");
  });

  const cases: [TransformOutcome, string][] = [
    [{ kind: "notInserted", reason: "focusChanged" }, "Focus changed. Result is in Voice"],
    [{ kind: "notInserted", reason: "noFocusedField" }, "Can't write here. Result is in Voice"],
    [{ kind: "notInserted", reason: "secureInput" }, "Secure field. Result is in Voice"],
    [{ kind: "notInserted", reason: "selectionChanged" }, "Text changed. Result is in Voice"],
    [{ kind: "notInserted", reason: "failed" }, "Not replaced. Result is in Voice"],
    [{ kind: "noSelection" }, "Select text first"],
    [{ kind: "secureInput" }, "Can't read a secure field"],
    [{ kind: "noFocusedField" }, "Click into the text first"],
    [{ kind: "keysHeld" }, "Release the keys, then try again"],
    [{ kind: "tooLong", maxWords: 640 }, "Too long. Select up to 640 words"],
    [{ kind: "modelUnavailable", state: "missing" }, "Set up the transform model in Voice"],
    [{ kind: "modelUnavailable", state: "downloading" }, "Transform model downloading"],
    [
      { kind: "modelUnavailable", state: "downloading", progress: 0.426 },
      "Transform model downloading 43%",
    ],
    [{ kind: "modelUnavailable", state: "failed" }, "Transform model failed. See Models"],
    [{ kind: "cancelled" }, "Cancelled. Text unchanged"],
    [
      { kind: "failed", message: "The transform took too long. Text unchanged" },
      "The transform took too long. Text unchanged",
    ],
  ];

  test.each(cases)("%j reads %s", (outcome, text) => {
    expect(transformDone(outcome)).toEqual({ kind: "message", text });
  });

  test.each(cases)("%j never claims a copy", (outcome) => {
    const view = transformDone(outcome);
    if (view.kind !== "message") throw new Error("expected a message");
    expect(view.text).not.toContain("clipboard");
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

const recording: PillMeeting = {
  status: { kind: "recording", since: 100_000 },
  closedMs: 60_000,
  prompt: null,
};
const at = (meeting: PillMeeting | null, session: PillState = { kind: "idle" }, now = 165_000) =>
  flowBarView({ session, alwaysShowPill: true, meeting }, now);

const snapshot = (meeting: PillMeeting | null, session: PillState = { kind: "idle" }) => ({
  session,
  alwaysShowPill: true,
  meeting,
});

describe("flowBarView", () => {
  test("a recording meeting shows its running time with the recording look", () => {
    expect(at(recording)).toEqual({ kind: "meeting", look: "recording", text: "02:05" });
  });

  test("dictation mid-meeting shows dictation, and the meeting comes back after", () => {
    expect(at(recording, { kind: "listening" })).toEqual({ kind: "listening" });
    expect(at(recording, { kind: "processing", overdue: false })).toEqual({ kind: "processing" });
    expect(at(recording, { kind: "done", outcome: { kind: "inserted", method: "paste" } })).toEqual(
      { kind: "inserted", method: "paste" },
    );
    expect(at(recording, { kind: "idle" })).toMatchObject({ kind: "meeting" });
  });

  test("a paused meeting never looks like it is recording", () => {
    expect(at({ ...recording, status: { kind: "paused" } })).toEqual({
      kind: "meeting",
      look: "paused",
      text: "Paused · 01:00",
    });
    expect(at({ ...recording, status: { kind: "starting", from: "new" } })).toEqual({
      kind: "meeting",
      look: "waiting",
      text: "Starting…",
    });
  });

  test("asks the meeting's questions in place of the clock", () => {
    expect(at({ ...recording, prompt: { kind: "silence" } })).toMatchObject({
      look: "prompt",
      text: "Still in a meeting?",
    });
    expect(at({ ...recording, status: { kind: "confirmingShort" } })).toMatchObject({
      look: "prompt",
      text: "Started by mistake?",
    });
    expect(
      at({ ...recording, prompt: { kind: "maxLengthSoon", endsAt: 165_000 + 4 * 60_000 + 1 } }),
    ).toMatchObject({ look: "prompt", text: "Recording ends in 5 min" });
  });

  test("a notice is left to the notepad; the Flow Bar keeps the status", () => {
    const paused: PillMeeting = {
      ...recording,
      status: { kind: "paused" },
      prompt: { kind: "notice", text: "Audio stopped coming in." },
    };
    expect(at(paused)).toMatchObject({ look: "paused" });
  });

  test("ticks only while it shows a running clock", () => {
    expect(ticks(snapshot(recording))).toBe(true);
    expect(ticks(snapshot({ ...recording, status: { kind: "paused" } }))).toBe(false);
    expect(ticks(snapshot(recording, { kind: "listening" }))).toBe(false);
    expect(ticks(snapshot(null))).toBe(false);
  });
});

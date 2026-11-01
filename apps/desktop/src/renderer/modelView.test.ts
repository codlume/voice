import { describe, expect, test } from "vite-plus/test";

import { models } from "../shared/models.ts";
import { activityOf, modelView } from "./modelView.ts";

const [asr, cleanup, transform] = models;

const idle = { cleanupEnabled: true, activity: "idle" } as const;
const install = { label: "Install", disabled: false };
const retry = { label: "Retry", disabled: false };
const uninstall = { label: "Uninstall", disabled: false };
const cancel = { label: "Cancel", disabled: false };

describe("modelView", () => {
  test("a missing model offers only Install", () => {
    expect(modelView(asr, { state: "missing" }, idle)).toEqual({
      text: "Not installed",
      actions: [install],
    });
  });

  test("a cleanup download offers Cancel, a speech model download nothing", () => {
    expect(modelView(cleanup, { state: "downloading" }, idle)).toEqual({
      text: "Downloading",
      actions: [cancel],
    });
    expect(modelView(cleanup, { state: "downloading", progress: 0.426 }, idle)).toEqual({
      text: "Downloading 43%",
      actions: [cancel],
    });
    expect(modelView(asr, { state: "downloading", progress: 0.426 }, idle)).toEqual({
      text: "Downloading 43%",
      actions: [],
    });
  });

  test("a long speech model load says it is preparing for this Mac", () => {
    expect(modelView(asr, { state: "loading", preparing: true }, idle)).toEqual({
      text: "Preparing for this Mac, about 30 s",
      actions: [],
    });
  });

  test("a load in flight offers nothing to click", () => {
    expect(modelView(asr, { state: "loading" }, idle)).toEqual({ text: "Loading", actions: [] });
    expect(modelView(cleanup, { state: "loading" }, idle)).toEqual({
      text: "Loading",
      actions: [],
    });
  });

  test("a model on disk can be uninstalled whether or not it is loaded", () => {
    expect(modelView(asr, { state: "ready" }, idle)).toEqual({
      text: "Installed",
      actions: [uninstall],
    });
    expect(modelView(cleanup, { state: "installed" }, idle)).toEqual({
      text: "Installed. Loads when you dictate in English.",
      actions: [uninstall],
    });
  });

  test("an installed cleanup model says what turns it back on", () => {
    const off = { ...idle, cleanupEnabled: false };
    expect(modelView(cleanup, { state: "installed" }, off).text).toBe(
      "Installed. Loads when text cleanup is on.",
    );
  });

  test("an installed transform model says it loads on use, whatever cleanup is set to", () => {
    for (const cleanupEnabled of [true, false]) {
      expect(modelView(transform, { state: "installed" }, { ...idle, cleanupEnabled })).toEqual({
        text: "Installed. Loads when you run a transform.",
        actions: [uninstall],
      });
    }
  });

  test("a failure shows its message and offers Retry or Uninstall", () => {
    expect(modelView(asr, { state: "failed", message: "offline" }, idle)).toEqual({
      text: "offline",
      actions: [retry, uninstall],
    });
  });

  test("dictation locks only the speech model's Uninstall", () => {
    const dictating = { ...idle, activity: "dictation" } as const;
    const locked = { label: "Uninstall", disabled: true };
    expect(modelView(asr, { state: "ready" }, dictating).actions).toEqual([locked]);
    expect(modelView(asr, { state: "failed", message: "offline" }, dictating).actions).toEqual([
      retry,
      locked,
    ]);
    expect(modelView(cleanup, { state: "ready" }, dictating).actions).toEqual([uninstall]);
    expect(modelView(transform, { state: "ready" }, dictating).actions).toEqual([uninstall]);
    expect(modelView(asr, { state: "missing" }, dictating).actions).toEqual([install]);
  });

  test("a transform run locks only the transform model's Uninstall", () => {
    const transforming = { ...idle, activity: "transform" } as const;
    const locked = { label: "Uninstall", disabled: true };
    expect(modelView(transform, { state: "ready" }, transforming).actions).toEqual([locked]);
    expect(modelView(transform, { state: "installed" }, transforming).actions).toEqual([locked]);
    expect(modelView(asr, { state: "ready" }, transforming).actions).toEqual([uninstall]);
    expect(modelView(cleanup, { state: "ready" }, transforming).actions).toEqual([uninstall]);
  });

  test("the pill state names the activity that locks a model", () => {
    expect(activityOf({ kind: "transforming", loading: true })).toBe("transform");
    expect(activityOf({ kind: "listening" })).toBe("dictation");
    expect(activityOf({ kind: "processing", overdue: false })).toBe("dictation");
    expect(activityOf({ kind: "idle" })).toBe("idle");
    expect(
      activityOf({ kind: "transformDone", outcome: { kind: "inserted", method: "accessibility" } }),
    ).toBe("idle");
  });
});

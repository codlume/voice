import { describe, expect, test } from "vite-plus/test";

import { models } from "../shared/models.ts";
import { modelView } from "./modelView.ts";

const [asr, cleanup] = models;

const idle = { cleanupEnabled: true, dictating: false };
const install = { label: "Install", disabled: false };
const retry = { label: "Retry", disabled: false };
const uninstall = { label: "Uninstall", disabled: false };

describe("modelView", () => {
  test("a missing model offers only Install", () => {
    expect(modelView(asr, { state: "missing" }, idle)).toEqual({
      text: "Not installed",
      actions: [install],
    });
  });

  test("a download or load in flight offers nothing to click", () => {
    expect(modelView(asr, { state: "downloading" }, idle)).toEqual({
      text: "Downloading",
      actions: [],
    });
    expect(modelView(asr, { state: "downloading", progress: 0.426 }, idle)).toEqual({
      text: "Downloading 43%",
      actions: [],
    });
    expect(modelView(asr, { state: "loading" }, idle)).toEqual({ text: "Loading", actions: [] });
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

  test("a failure shows its message and offers Retry or Uninstall", () => {
    expect(modelView(asr, { state: "failed", message: "offline" }, idle)).toEqual({
      text: "offline",
      actions: [retry, uninstall],
    });
  });

  test("dictation locks only the speech model's Uninstall", () => {
    const dictating = { ...idle, dictating: true };
    const locked = { label: "Uninstall", disabled: true };
    expect(modelView(asr, { state: "ready" }, dictating).actions).toEqual([locked]);
    expect(modelView(asr, { state: "failed", message: "offline" }, dictating).actions).toEqual([
      retry,
      locked,
    ]);
    expect(modelView(cleanup, { state: "ready" }, dictating).actions).toEqual([uninstall]);
    expect(modelView(asr, { state: "missing" }, dictating).actions).toEqual([install]);
  });
});

import { describe, expect, test } from "vite-plus/test";

import { modelView } from "./modelView.ts";

describe("modelView", () => {
  test("a missing model offers only Install", () => {
    expect(modelView({ state: "missing" }, true)).toEqual({
      text: "Not installed",
      actions: ["Install"],
    });
  });

  test("a download or load in flight offers nothing to click", () => {
    expect(modelView({ state: "downloading" }, true)).toEqual({
      text: "Downloading",
      actions: [],
    });
    expect(modelView({ state: "downloading", progress: 0.426 }, true)).toEqual({
      text: "Downloading 43%",
      actions: [],
    });
    expect(modelView({ state: "loading" }, true)).toEqual({ text: "Loading", actions: [] });
  });

  test("a model on disk can be uninstalled whether or not it is loaded", () => {
    expect(modelView({ state: "ready" }, true)).toEqual({
      text: "Installed",
      actions: ["Uninstall"],
    });
    expect(modelView({ state: "installed" }, true)).toEqual({
      text: "Installed. Loads when you dictate in English.",
      actions: ["Uninstall"],
    });
  });

  test("an installed cleanup model says what turns it back on", () => {
    expect(modelView({ state: "installed" }, false).text).toBe(
      "Installed. Loads when text cleanup is on.",
    );
  });

  test("a failure shows its message and offers Retry or Uninstall", () => {
    expect(modelView({ state: "failed", message: "offline" }, true)).toEqual({
      text: "offline",
      actions: ["Retry", "Uninstall"],
    });
  });
});

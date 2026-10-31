import { describe, expect, test } from "vite-plus/test";

import { DEFAULT_SETTINGS } from "../shared/api.ts";
import { DEFAULT_TRANSFORMS } from "../shared/transforms.ts";
import { hotkeyConfigure } from "./hotkey-config.ts";

const on = { ...DEFAULT_SETTINGS, transforms: { ...DEFAULT_TRANSFORMS, enabled: true } };

describe("hotkeyConfigure", () => {
  test("carries the dictation keys and no transforms by default", () => {
    expect(hotkeyConfigure({ ...DEFAULT_SETTINGS, toggleHotkey: "rightCommand" }, false)).toEqual({
      type: "hotkey.configure",
      key: "fn",
      toggleKey: "rightCommand",
      transforms: [],
      meeting: { keycode: 46, modifiers: ["option"] },
    });
  });

  test("registers the shortcuts once Transforms are on, except while a Voice window is focused", () => {
    expect(hotkeyConfigure(on, false).transforms).toEqual([
      { id: "polish", keycode: 18, modifiers: ["option"] },
      { id: "prompt-engineer", keycode: 19, modifiers: ["option"] },
    ]);
    expect(hotkeyConfigure(on, true).transforms).toEqual([]);
  });

  test("hands the meeting shortcut to the helper unless a Voice window is focused or it is off", () => {
    expect(hotkeyConfigure(DEFAULT_SETTINGS, false).meeting).toEqual({
      keycode: 46,
      modifiers: ["option"],
    });
    expect(hotkeyConfigure(DEFAULT_SETTINGS, true).meeting).toBeNull();
    expect(
      hotkeyConfigure({ ...DEFAULT_SETTINGS, meetingShortcut: null }, false).meeting,
    ).toBeNull();
  });
});

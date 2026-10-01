import { describe, expect, test } from "vite-plus/test";

import { jumpShortcuts, matches, shortcuts, showsHints, type Shortcut } from "./shortcuts.ts";

const all: Shortcut[] = [...Object.values(shortcuts), ...jumpShortcuts];

type Modifiers = { code?: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean };

function keyEvent(key: string, modifiers: Modifiers = {}) {
  return {
    key,
    code: modifiers.code ?? "",
    metaKey: modifiers.meta ?? true,
    ctrlKey: modifiers.ctrl ?? false,
    altKey: modifiers.alt ?? false,
    shiftKey: modifiers.shift ?? false,
  };
}

function press(key: string, modifiers?: Modifiers) {
  const event = keyEvent(key, modifiers);
  return all.filter((shortcut) => matches(shortcut, event));
}

describe("matches", () => {
  test.each([
    ["b", shortcuts.toggleSidebar],
    ["B", shortcuts.toggleSidebar],
    [",", shortcuts.openSettings],
    ["[", shortcuts.closeSettings],
  ])("⌘%s", (key, shortcut) => {
    expect(press(key)).toEqual([shortcut]);
  });

  test.each([
    ["1", "Digit1", 0],
    ["9", "Digit9", 8],
    ["1", "Numpad1", 0],
  ])("⌘%s (%s) jumps", (key, code, index) => {
    expect(press(key, { code })).toEqual([jumpShortcuts[index]]);
  });

  test("⌘0 is not a jump", () => {
    expect(press("0", { code: "Digit0" })).toEqual([]);
  });

  test("digits fall back to the physical key on non-US layouts", () => {
    expect(press("&", { code: "Digit1" })).toEqual([jumpShortcuts[0]]);
  });

  test.each([
    ["⇧⌘B", { shift: true }],
    ["⌥⌘B", { alt: true }],
    ["⌃⌘B", { ctrl: true }],
    ["plain B", { meta: false }],
  ])("%s does nothing", (_, modifiers) => {
    expect(press("b", modifiers)).toEqual([]);
  });

  test("⇧⌘1 does nothing", () => {
    expect(press("!", { code: "Digit1", shift: true })).toEqual([]);
  });
});

test("shortcut hints", () => {
  expect(shortcuts.toggleSidebar.hint).toBe("⌘B");
  expect(shortcuts.openSettings.hint).toBe("⌘,");
  expect(jumpShortcuts.map(({ hint }) => hint)).toEqual(
    ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => `⌘${digit}`),
  );
});

describe("showsHints", () => {
  test("⌘ on its own shows hints", () => {
    expect(showsHints(keyEvent("Meta", { code: "MetaLeft" }), "fn")).toBe(true);
    expect(showsHints(keyEvent("Meta", { code: "MetaRight" }), "fn")).toBe(true);
  });

  test("⌘ with another modifier does not", () => {
    expect(showsHints(keyEvent("Meta", { code: "MetaLeft", shift: true }), "fn")).toBe(false);
  });

  test("holding Right ⌘ to dictate does not", () => {
    expect(showsHints(keyEvent("Meta", { code: "MetaRight" }), "rightCommand")).toBe(false);
    expect(showsHints(keyEvent("Meta", { code: "MetaLeft" }), "rightCommand")).toBe(true);
  });
});

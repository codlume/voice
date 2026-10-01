import { describe, expect, test } from "vite-plus/test";

import { jumpLabel, matchShortcut, shortcuts } from "./shortcuts.ts";

function press(
  key: string,
  modifiers: { code?: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {},
) {
  return matchShortcut({
    key,
    code: modifiers.code ?? "",
    metaKey: modifiers.meta ?? true,
    ctrlKey: modifiers.ctrl ?? false,
    altKey: modifiers.alt ?? false,
    shiftKey: modifiers.shift ?? false,
  });
}

describe("matchShortcut", () => {
  test.each([
    ["b", { command: "toggleSidebar" }],
    ["B", { command: "toggleSidebar" }],
    [",", { command: "openSettings" }],
    ["[", { command: "closeSettings" }],
  ])("⌘%s", (key, action) => {
    expect(press(key)).toEqual(action);
  });

  test.each([
    ["1", "Digit1", 0],
    ["9", "Digit9", 8],
    ["1", "Numpad1", 0],
  ])("⌘%s (%s) jumps", (key, code, index) => {
    expect(press(key, { code })).toEqual({ command: "jump", index });
  });

  test("⌘0 is not a jump", () => {
    expect(press("0", { code: "Digit0" })).toBeNull();
  });

  test("digits fall back to the physical key on non-US layouts", () => {
    expect(press("&", { code: "Digit1" })).toEqual({ command: "jump", index: 0 });
  });

  test.each([
    ["⇧⌘B", { shift: true }],
    ["⌥⌘B", { alt: true }],
    ["⌃⌘B", { ctrl: true }],
    ["plain B", { meta: false }],
  ])("%s does nothing", (_, modifiers) => {
    expect(press("b", modifiers)).toBeNull();
  });

  test("⇧⌘1 does nothing", () => {
    expect(press("!", { code: "Digit1", shift: true })).toBeNull();
  });
});

test("shortcut hints", () => {
  expect(shortcuts.toggleSidebar.hint).toBe("⌘B");
  expect(shortcuts.openSettings.hint).toBe("⌘,");
});

test("every sidebar hint is a shortcut that jumps to that item", () => {
  const labelled = Array.from({ length: 12 }, (_, index) => index).filter(
    (index) => jumpLabel(index) !== undefined,
  );
  expect(labelled).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  for (const index of labelled) {
    expect(jumpLabel(index)).toBe(`⌘${index + 1}`);
    expect(press(String(index + 1), { code: `Digit${index + 1}` })).toEqual({
      command: "jump",
      index,
    });
  }
});

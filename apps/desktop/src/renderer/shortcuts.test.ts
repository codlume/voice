import { describe, expect, test } from "vite-plus/test";

import { matchShortcut, shortcutLabel } from "./shortcuts.ts";

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
    ["1", { command: "jump", index: 0 }],
    ["9", { command: "jump", index: 8 }],
  ])("⌘%s", (key, action) => {
    expect(press(key)).toEqual(action);
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

test("shortcutLabel", () => {
  expect(shortcutLabel("b")).toBe("⌘B");
  expect(shortcutLabel(",")).toBe("⌘,");
});

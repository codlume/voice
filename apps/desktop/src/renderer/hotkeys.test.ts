import { expect, test } from "vite-plus/test";

import { dictatesWithFn } from "./hotkeys.ts";

test("fn dictates when it is the hold key or the toggle key", () => {
  expect(dictatesWithFn({ hotkey: "fn", toggleHotkey: null })).toBe(true);
  expect(dictatesWithFn({ hotkey: "rightOption", toggleHotkey: "fn" })).toBe(true);
  expect(dictatesWithFn({ hotkey: "rightOption", toggleHotkey: null })).toBe(false);
  expect(dictatesWithFn({ hotkey: "rightOption", toggleHotkey: "rightCommand" })).toBe(false);
});

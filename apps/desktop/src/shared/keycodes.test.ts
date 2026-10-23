import { describe, expect, test } from "vite-plus/test";

import { codeForKeycode, keycodeForCode, usLabel } from "./keycodes.ts";
import { parseShortcut } from "./transforms.ts";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const DIGITS = "0123456789".split("");
const F_KEYS = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);
const PUNCTUATION = [
  "Minus",
  "Equal",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Semicolon",
  "Quote",
  "Comma",
  "Period",
  "Slash",
  "Backquote",
];
const OTHERS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space", "Tab", "Enter"];
const CODES = [
  ...LETTERS.map((letter) => `Key${letter}`),
  ...DIGITS.map((digit) => `Digit${digit}`),
  ...F_KEYS,
  ...PUNCTUATION,
  ...OTHERS,
];

describe("keycodes", () => {
  test.each([
    ["KeyA", 0],
    ["KeyC", 8],
    ["KeyV", 9],
    ["KeyQ", 12],
    ["KeyW", 13],
    ["KeyX", 7],
    ["KeyZ", 6],
    ["Digit1", 18],
    ["Digit2", 19],
    ["Digit5", 23],
    ["Digit0", 29],
    ["Tab", 48],
    ["Space", 49],
    ["Enter", 36],
    ["F1", 122],
    ["F12", 111],
    ["ArrowUp", 126],
  ])("%s is kVK %i", (code, keycode) => {
    expect(keycodeForCode(code)).toBe(keycode);
  });

  test("covers letters, digits, punctuation, F1 to F12, arrows, Space, Tab and Return", () => {
    for (const code of CODES) expect(keycodeForCode(code), code).not.toBeNull();
  });

  test("every key has its own keycode that a shortcut can store, and maps back to its code", () => {
    const keycodes = CODES.map((code) => keycodeForCode(code));
    expect(new Set(keycodes).size).toBe(CODES.length);
    for (const [i, keycode] of keycodes.entries()) {
      if (keycode === null) throw new Error(`no keycode for ${CODES[i]}`);
      expect(parseShortcut({ keycode, modifiers: ["option"] })).not.toBeNull();
      expect(codeForKeycode(keycode)).toBe(CODES[i]);
    }
  });

  test.each([
    "AltLeft",
    "MetaRight",
    "ShiftLeft",
    "ControlLeft",
    "CapsLock",
    "Fn",
    "Escape",
    "Backspace",
    "Numpad1",
    "",
  ])("%j is not a shortcut key", (code) => {
    expect(keycodeForCode(code)).toBeNull();
  });

  test("labels keys the way a US keyboard prints them", () => {
    expect(usLabel(0)).toBe("A");
    expect(usLabel(18)).toBe("1");
    expect(usLabel(27)).toBe("-");
    expect(usLabel(49)).toBe("Space");
    expect(usLabel(123)).toBe("←");
    expect(usLabel(122)).toBe("F1");
    expect(usLabel(127)).toBeNull();
  });
});

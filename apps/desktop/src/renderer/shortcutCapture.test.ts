import { describe, expect, test } from "vite-plus/test";

import { BUILT_IN_TRANSFORMS, type Shortcut } from "../shared/transforms.ts";
import {
  capture,
  keyLabel,
  shortcutLabel,
  shortcutNotes,
  type KeyboardLayout,
  type KeyPress,
} from "./shortcutCapture.ts";

const press = (code: string, held: Partial<Omit<KeyPress, "code">> = {}): KeyPress => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...held,
});
const option = { altKey: true };
const command = { metaKey: true };

// Dvorak puts j on the US c key and c on the US i key; AZERTY puts & on the 1 key.
const DVORAK: KeyboardLayout = new Map([
  ["KeyC", "j"],
  ["KeyI", "c"],
  ["KeyK", "t"],
]);
const AZERTY: KeyboardLayout = new Map([
  ["Digit1", "&"],
  ["KeyQ", "a"],
  ["KeyA", "q"],
]);

const context = { others: BUILT_IN_TRANSFORMS, layout: null };

describe("capture", () => {
  test("records a key with Control, Option or Command, in canonical order", () => {
    expect(
      capture(press("KeyK", { metaKey: true, ctrlKey: true, shiftKey: true }), context),
    ).toEqual({
      kind: "recorded",
      shortcut: { keycode: 40, modifiers: ["control", "shift", "command"] },
    });
    expect(capture(press("Digit3", option), context)).toEqual({
      kind: "recorded",
      shortcut: { keycode: 20, modifiers: ["option"] },
    });
  });

  test("Escape cancels and Backspace clears, whatever is held", () => {
    expect(capture(press("Escape"), context)).toEqual({ kind: "cancel" });
    expect(capture(press("Backspace"), context)).toEqual({ kind: "clear" });
    expect(capture(press("Backspace", option), context)).toEqual({ kind: "clear" });
  });

  test("a modifier alone stays pending and reports what is held", () => {
    expect(capture(press("AltLeft", option), context)).toEqual({
      kind: "pending",
      modifiers: ["option"],
    });
    expect(capture(press("MetaRight", { ...command, shiftKey: true }), context)).toEqual({
      kind: "pending",
      modifiers: ["shift", "command"],
    });
  });

  test.each([
    ["no modifier", press("KeyK")],
    ["Shift alone", press("KeyK", { shiftKey: true })],
  ])("refuses %s", (_label, keyPress) => {
    expect(capture(keyPress, context)).toEqual({
      kind: "refused",
      message: "Hold Control, Option or Command with the key.",
    });
  });

  test("refuses a key the helper cannot match", () => {
    expect(capture(press("Numpad1", option), context).kind).toBe("refused");
    expect(capture(press("IntlBackslash", option), context).kind).toBe("refused");
  });

  test("refuses another transform's shortcut and names it", () => {
    expect(capture(press("Digit1", option), context)).toEqual({
      kind: "refused",
      message: "Polish already uses ⌥1.",
    });
    expect(capture(press("Digit1", option), { ...context, others: [] }).kind).toBe("recorded");
  });

  test.each(["KeyC", "KeyV", "KeyX", "KeyZ", "KeyA", "KeyQ", "KeyW", "Tab"])(
    "refuses Command with %s",
    (code) => {
      const result = capture(press(code, command), context);
      expect(result.kind).toBe("refused");
      expect(capture(press(code, { ...command, shiftKey: true }), context).kind).toBe("refused");
    },
  );

  test("Command with Control or Option on a reserved key is a shortcut of its own", () => {
    expect(capture(press("KeyC", { ...command, altKey: true }), context).kind).toBe("recorded");
    expect(capture(press("KeyC", { ...command, ctrlKey: true }), context).kind).toBe("recorded");
    expect(capture(press("KeyC", option), context).kind).toBe("recorded");
  });

  test("the layout's character counts as well as the US position", () => {
    const dvorak = { ...context, layout: DVORAK };
    expect(capture(press("KeyI", command), dvorak)).toEqual({
      kind: "refused",
      message: "⌘C is a system shortcut. Choose another.",
    });
    expect(capture(press("KeyC", command), dvorak).kind).toBe("refused");
    expect(capture(press("KeyK", command), dvorak).kind).toBe("recorded");
  });
});

describe("labels", () => {
  const optionOne: Shortcut = { keycode: 18, modifiers: ["option"] };

  test("show glyphs in ⌃⌥⇧⌘ order, then the key", () => {
    const every: Shortcut = { keycode: 40, modifiers: ["control", "option", "shift", "command"] };
    expect(shortcutLabel(every, null)).toBe("⌃⌥⇧⌘K");
    expect(shortcutLabel(optionOne, null)).toBe("⌥1");
  });

  test("use the layout's character, uppercased", () => {
    expect(shortcutLabel(optionOne, AZERTY)).toBe("⌥&");
    expect(keyLabel(12, AZERTY)).toBe("A");
    expect(keyLabel(8, DVORAK)).toBe("J");
  });

  test("fall back to the US label without a layout or a character for the key", () => {
    expect(keyLabel(40, AZERTY)).toBe("K");
    expect(keyLabel(49, AZERTY)).toBe("Space");
    expect(keyLabel(122, null)).toBe("F1");
    expect(keyLabel(126, new Map([["ArrowUp", " "]]))).toBe("↑");
  });
});

describe("shortcutNotes", () => {
  test("an Option or Command shortcut on the dictation key's side says which side fires", () => {
    const optionOne: Shortcut = { keycode: 18, modifiers: ["option", "command"] };
    expect(shortcutNotes(optionOne, ["rightOption"])).toEqual([
      "Right Option starts dictation. This shortcut fires from the left Option key.",
    ]);
    expect(shortcutNotes(optionOne, ["fn", "rightCommand"])).toEqual([
      "Right Command starts dictation. This shortcut fires from the left Command key.",
    ]);
    expect(shortcutNotes(optionOne, ["fn"])).toEqual([]);
    expect(shortcutNotes({ keycode: 18, modifiers: ["control"] }, ["rightOption"])).toEqual([]);
  });

  test("an Option combination that types a character says it takes that character", () => {
    const note = "Option shortcuts replace the character this combination types in other apps.";
    expect(shortcutNotes({ keycode: 18, modifiers: ["option"] }, ["fn"])).toEqual([note]);
    expect(shortcutNotes({ keycode: 0, modifiers: ["option", "shift"] }, ["fn"])).toEqual([note]);
    expect(shortcutNotes({ keycode: 18, modifiers: ["control", "option"] }, ["fn"])).toEqual([]);
    expect(shortcutNotes({ keycode: 18, modifiers: ["option", "command"] }, ["fn"])).toEqual([]);
    expect(shortcutNotes({ keycode: 123, modifiers: ["option"] }, ["fn"])).toEqual([]);
    expect(shortcutNotes({ keycode: 122, modifiers: ["option"] }, ["fn"])).toEqual([]);
    expect(shortcutNotes({ keycode: 36, modifiers: ["option"] }, ["fn"])).toEqual([]);
  });

  test("Option+Space says it takes the non-breaking space", () => {
    expect(shortcutNotes({ keycode: 49, modifiers: ["option"] }, ["fn"])).toEqual([
      "Option shortcuts replace the character this combination types in other apps.",
    ]);
  });
});

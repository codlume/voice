import type { Hotkey } from "../shared/api.ts";
import { codeForKeycode, keycodeForCode, typesCharacter, usLabel } from "../shared/keycodes.ts";
import {
  MODIFIERS,
  parseShortcut,
  sameShortcut,
  type Modifier,
  type Shortcut,
  type ShortcutHolder,
} from "../shared/transforms.ts";

export type KeyboardLayout = ReadonlyMap<string, string>;

export type KeyPress = Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

export type Capture =
  /** Tab or Shift+Tab, left to the browser so keyboard focus can leave the picker either way. */
  | { kind: "pass" }
  | { kind: "cancel" }
  | { kind: "clear" }
  | { kind: "pending"; modifiers: readonly Modifier[] }
  | { kind: "refused"; message: string }
  | { kind: "recorded"; shortcut: Shortcut };

const GLYPHS: Record<Modifier, string> = { control: "⌃", option: "⌥", shift: "⇧", command: "⌘" };

const RESERVED_WITH_COMMAND = new Set(["c", "v", "x", "z", "a", "q", "w"]);
const TAB = keycodeForCode("Tab");

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "CapsLock",
  "Fn",
]);

export const heldModifiers = (press: Omit<KeyPress, "code">): Modifier[] =>
  MODIFIERS.filter(
    (modifier) =>
      ({
        control: press.ctrlKey,
        option: press.altKey,
        shift: press.shiftKey,
        command: press.metaKey,
      })[modifier],
  );

export function keyLabel(keycode: number, layout: KeyboardLayout | null): string {
  const code = codeForKeycode(keycode);
  const typed = code === null ? undefined : layout?.get(code);
  if (typed !== undefined && typed.trim().length === 1) return typed.toUpperCase();
  return usLabel(keycode) ?? `Key ${keycode}`;
}

export const modifierKeys = (modifiers: readonly Modifier[]): string[] =>
  modifiers.map((modifier) => GLYPHS[modifier]);

export const shortcutKeys = (shortcut: Shortcut, layout: KeyboardLayout | null): string[] => [
  ...modifierKeys(shortcut.modifiers),
  keyLabel(shortcut.keycode, layout),
];

export const shortcutLabel = (shortcut: Shortcut, layout: KeyboardLayout | null): string =>
  shortcutKeys(shortcut, layout).join("");

function isReserved({ keycode, modifiers }: Shortcut, layout: KeyboardLayout | null): boolean {
  if (!modifiers.includes("command")) return false;
  if (modifiers.includes("control") || modifiers.includes("option")) return false;
  if (keycode === TAB) return true;
  const code = codeForKeycode(keycode);
  const typed = (code !== null && layout?.get(code)) || "";
  // Either reading counts: the layout says what Command+key does in most apps, but some apps
  // match Command shortcuts by US position.
  return [typed, usLabel(keycode) ?? ""].some((character) =>
    RESERVED_WITH_COMMAND.has(character.toLowerCase()),
  );
}

export const MEETING_SHORTCUT_TITLE = "Start or stop a meeting";

export const meetingShortcutHolder = (shortcut: Shortcut | null): ShortcutHolder => ({
  name: MEETING_SHORTCUT_TITLE,
  shortcut,
});

/** Whether a key press is `shortcut`, matched by key position like the helper's tap. */
export function pressMatches(shortcut: Shortcut, press: KeyPress): boolean {
  const keycode = keycodeForCode(press.code);
  return keycode !== null && sameShortcut({ keycode, modifiers: heldModifiers(press) }, shortcut);
}

export function capture(
  press: KeyPress,
  {
    others,
    layout,
  }: {
    others: readonly ShortcutHolder[];
    layout: KeyboardLayout | null;
  },
): Capture {
  if (press.code === "Tab" && !press.ctrlKey && !press.altKey && !press.metaKey) {
    return { kind: "pass" };
  }
  if (press.code === "Escape") return { kind: "cancel" };
  if (press.code === "Backspace" || press.code === "Delete") return { kind: "clear" };
  const modifiers = heldModifiers(press);
  if (MODIFIER_CODES.has(press.code)) return { kind: "pending", modifiers };
  const keycode = keycodeForCode(press.code);
  if (keycode === null)
    return { kind: "refused", message: "This key can't be part of a shortcut." };
  const shortcut = parseShortcut({ keycode, modifiers });
  if (shortcut === null) {
    return { kind: "refused", message: "Hold Control, Option or Command with the key." };
  }
  const label = shortcutLabel(shortcut, layout);
  if (isReserved(shortcut, layout)) {
    return { kind: "refused", message: `${label} is a system shortcut. Choose another.` };
  }
  const holder = others.find((other) => other.shortcut && sameShortcut(other.shortcut, shortcut));
  if (holder) return { kind: "refused", message: `${holder.name} already uses ${label}.` };
  return { kind: "recorded", shortcut };
}

const SIDES: readonly { modifier: Modifier; hotkey: Hotkey; name: string }[] = [
  { modifier: "option", hotkey: "rightOption", name: "Option" },
  { modifier: "command", hotkey: "rightCommand", name: "Command" },
];

export function shortcutNotes(
  { keycode, modifiers }: Shortcut,
  dictationKeys: readonly Hotkey[],
): string[] {
  const notes = SIDES.filter(
    ({ modifier, hotkey }) => modifiers.includes(modifier) && dictationKeys.includes(hotkey),
  ).map(
    ({ name }) => `Right ${name} starts dictation. This shortcut fires from the left ${name} key.`,
  );
  const takesCharacter =
    typesCharacter(keycode) &&
    modifiers.includes("option") &&
    !modifiers.includes("control") &&
    !modifiers.includes("command");
  if (takesCharacter) {
    notes.push("Option shortcuts replace the character this combination types in other apps.");
  }
  return notes;
}

import { useEffect, useEffectEvent, useState } from "react";

import type { Shortcut as KeyCombo } from "../shared/transforms.ts";
import { dictationKeys, type DictationKeySettings } from "./hotkeys.ts";
import { pressMatches } from "./shortcutCapture.ts";

type ShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

export type Shortcut = { key: string; keys: readonly string[]; hint: string };

function shortcut(key: string): Shortcut {
  const keys = ["⌘", key.toUpperCase()];
  return { key, keys, hint: keys.join("") };
}

export const shortcuts = {
  toggleSidebar: shortcut("b"),
  openSettings: shortcut(","),
  searchHistory: shortcut("f"),
  openHelp: shortcut("/"),
};

export const jumpShortcuts = Array.from({ length: 9 }, (_, index) => shortcut(String(index + 1)));

function noOtherModifiers(event: ShortcutEvent): boolean {
  return !event.ctrlKey && !event.altKey && !event.shiftKey;
}

export function matches({ key }: Shortcut, event: ShortcutEvent): boolean {
  if (!event.metaKey || !noOtherModifiers(event)) return false;
  // Match digits by physical key: layouts like AZERTY put symbols on the digit row.
  if (/^\d$/.test(key)) return event.code === `Digit${key}` || event.code === `Numpad${key}`;
  return event.key.toLowerCase() === key;
}

export function withShortcut(label: string, { hint }: Shortcut): string {
  return `${label} (${hint})`;
}

export type Binding = { shortcut: Shortcut; run: () => void };

function insideDialog(target: EventTarget | null, reachAppModal: boolean): boolean {
  const dialog =
    target instanceof Element ? target.closest('[role="dialog"],[role="alertdialog"]') : null;
  return dialog !== null && !(reachAppModal && dialog.hasAttribute("data-app-modal"));
}

/**
 * Bindings stand down while focus is inside a dialog. With `reachAppModal`, they also run inside
 * a dialog marked `data-app-modal`, which only the hub's own bindings use for its Settings modal.
 * A page behind that modal stays out, and so does any dialog opened over it.
 */
export function useShortcuts(bindings: readonly Binding[], { reachAppModal = false } = {}) {
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || insideDialog(event.target, reachAppModal)) return;
    const binding = bindings.find((candidate) => matches(candidate.shortcut, event));
    if (!binding) return;
    event.preventDefault();
    if (!event.repeat) binding.run();
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}

/**
 * The meeting shortcut while a Voice window has focus, where the helper's tap stands down so a
 * shortcut picker can record those keys. A picker that takes the press prevents its default.
 */
export function useMeetingShortcut(combo: KeyCombo | null, run: () => void) {
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (combo === null || event.defaultPrevented || !pressMatches(combo, event)) return;
    event.preventDefault();
    if (!event.repeat) run();
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}

export function showsHints(event: ShortcutEvent, settings: DictationKeySettings): boolean {
  const pressesDictationKey =
    event.code === "MetaRight" && dictationKeys(settings).includes("rightCommand");
  // Some input paths report metaKey false on the Meta keydown itself, so check the key.
  return event.key === "Meta" && noOtherModifiers(event) && !pressesDictationKey;
}

export function useCommandHeld({ hotkey, toggleHotkey }: DictationKeySettings): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      setHeld(showsHints(event, { hotkey, toggleHotkey }));
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.key === "Meta") setHeld(false);
    }
    // Switching apps with ⌘-Tab never delivers the Meta keyup to this window.
    function onBlur() {
      setHeld(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [hotkey, toggleHotkey]);

  return held;
}

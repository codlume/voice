import { useEffect, useEffectEvent, useState } from "react";

import { dictationKeys, type DictationKeySettings } from "./hotkeys.ts";

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
  closeSettings: shortcut("["),
  searchHistory: shortcut("f"),
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

function insideDialog(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest('[role="dialog"],[role="alertdialog"]') !== null
  );
}

export function useShortcuts(bindings: readonly Binding[]) {
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || insideDialog(event.target)) return;
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

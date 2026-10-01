import { useEffect, useEffectEvent, useState } from "react";

export type ShortcutCommand = "toggleSidebar" | "openSettings" | "closeSettings";

export const shortcuts: Record<ShortcutCommand, { label: string; key: string }> = {
  toggleSidebar: { label: "Toggle sidebar", key: "b" },
  openSettings: { label: "Open Settings", key: "," },
  closeSettings: { label: "Leave Settings", key: "[" },
};

export type ShortcutAction = { command: ShortcutCommand } | { command: "jump"; index: number };

const jumpLimit = 9;

const commandsByKey = new Map(
  Object.entries(shortcuts).map(([command, { key }]) => [key, command as ShortcutCommand]),
);

type ShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

function noOtherModifiers(event: ShortcutEvent): boolean {
  return !event.ctrlKey && !event.altKey && !event.shiftKey;
}

export function matchShortcut(event: ShortcutEvent): ShortcutAction | null {
  if (!event.metaKey || !noOtherModifiers(event)) return null;
  const key = event.key.toLowerCase();
  const command = commandsByKey.get(key);
  if (command) return { command };
  // Layouts like AZERTY put symbols on the digit row, so fall back to the physical key.
  const digit = Number(/^\d$/.test(key) ? key : /^Digit(\d)$/.exec(event.code)?.[1]);
  return digit >= 1 && digit <= jumpLimit ? { command: "jump", index: digit - 1 } : null;
}

export function shortcutKeys(key: string): string[] {
  return ["⌘", key.toUpperCase()];
}

export const jumpKeys = shortcutKeys(`1–${jumpLimit}`);

export function shortcutLabel(key: string): string {
  return shortcutKeys(key).join("");
}

export function jumpLabel(index: number): string | undefined {
  return index < jumpLimit ? shortcutLabel(String(index + 1)) : undefined;
}

export function withShortcut(label: string, shortcut: string): string {
  return `${label} (${shortcut})`;
}

/** Runs window shortcuts, and returns whether ⌘ is held on its own so callers can show hints. */
export function useShortcuts(run: (action: ShortcutAction) => void): boolean {
  const [hintsVisible, setHintsVisible] = useState(false);
  const onShortcut = useEffectEvent(run);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Some input paths report metaKey false on the Meta keydown itself, so check the key.
      setHintsVisible(event.key === "Meta" && noOtherModifiers(event));
      if (event.defaultPrevented) return;
      const action = matchShortcut(event);
      if (action === null) return;
      event.preventDefault();
      if (!event.repeat) onShortcut(action);
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.key === "Meta") setHintsVisible(false);
    }
    // Switching apps with ⌘-Tab never delivers the Meta keyup to this window.
    function onBlur() {
      setHintsVisible(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  return hintsVisible;
}

import { useEffect, useEffectEvent, useState } from "react";

const jumpLimit = 9;

function keys(key: string): string[] {
  return ["⌘", key.toUpperCase()];
}

function shortcut(title: string, key: string) {
  return { title, key, keys: keys(key), hint: keys(key).join("") };
}

export const shortcuts = {
  toggleSidebar: shortcut("Toggle sidebar", "b"),
  openSettings: shortcut("Open Settings", ","),
  closeSettings: shortcut("Leave Settings", "["),
};

type Command = keyof typeof shortcuts;

type ShortcutAction = { command: Command } | { command: "jump"; index: number };

type ShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

const commandsByKey = new Map(
  Object.entries(shortcuts).map(([command, { key }]) => [key, command as Command]),
);

function noOtherModifiers(event: ShortcutEvent): boolean {
  return !event.ctrlKey && !event.altKey && !event.shiftKey;
}

export function matchShortcut(event: ShortcutEvent): ShortcutAction | null {
  if (!event.metaKey || !noOtherModifiers(event)) return null;
  const command = commandsByKey.get(event.key.toLowerCase());
  if (command) return { command };
  // Match digits by physical key: layouts like AZERTY put symbols on the digit row.
  const digit = Number(/^(?:Digit|Numpad)(\d)$/.exec(event.code)?.[1] ?? 0);
  return digit >= 1 && digit <= jumpLimit ? { command: "jump", index: digit - 1 } : null;
}

export const jumpKeys = keys(`1–${jumpLimit}`);

export function jumpLabel(index: number): string | undefined {
  return index < jumpLimit ? keys(String(index + 1)).join("") : undefined;
}

export function withShortcut(label: string, hint: string): string {
  return `${label} (${hint})`;
}

/** Runs window shortcuts, and returns whether ⌘ is held on its own so callers can show hints. */
export function useShortcuts(
  handlers: Record<Command, () => void> & { jump: (index: number) => void },
): boolean {
  const [commandHeld, setCommandHeld] = useState(false);
  const run = useEffectEvent((action: ShortcutAction) => {
    if (action.command === "jump") handlers.jump(action.index);
    else handlers[action.command]();
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Some input paths report metaKey false on the Meta keydown itself, so check the key.
      setCommandHeld(event.key === "Meta" && noOtherModifiers(event));
      if (event.defaultPrevented) return;
      const action = matchShortcut(event);
      if (action === null) return;
      event.preventDefault();
      if (!event.repeat) run(action);
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.key === "Meta") setCommandHeld(false);
    }
    // Switching apps with ⌘-Tab never delivers the Meta keyup to this window.
    function onBlur() {
      setCommandHeld(false);
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

  return commandHeld;
}

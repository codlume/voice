export type ShortcutCommand = "toggleSidebar" | "openSettings" | "closeSettings";

export const shortcuts: Record<ShortcutCommand, { label: string; key: string; detail?: string }> = {
  toggleSidebar: { label: "Toggle sidebar", key: "b" },
  openSettings: { label: "Open Settings", key: "," },
  closeSettings: { label: "Back", key: "[", detail: "Leave Settings" },
};

export type ShortcutAction = { command: ShortcutCommand } | { command: "jump"; index: number };

const commandsByKey = new Map(
  Object.entries(shortcuts).map(([command, { key }]) => [key, command as ShortcutCommand]),
);

export function matchShortcut(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): ShortcutAction | null {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  const key = event.key.toLowerCase();
  const command = commandsByKey.get(key);
  if (command) return { command };
  // Layouts like AZERTY put symbols on the digit row, so fall back to the physical key.
  const digit = /^[1-9]$/.test(key) ? key : /^Digit([1-9])$/.exec(event.code)?.[1];
  return digit === undefined ? null : { command: "jump", index: Number(digit) - 1 };
}

export function shortcutKeys(key: string): string[] {
  return ["⌘", key.toUpperCase()];
}

export function shortcutLabel(key: string): string {
  return shortcutKeys(key).join("");
}

import type { Hotkey } from "../shared/api.ts";

const hotkeyKeys: Record<Hotkey, { label: string; symbol: string | null }> = {
  fn: { label: "fn", symbol: null },
  rightOption: { label: "Right Option", symbol: "⌥" },
  rightCommand: { label: "Right Command", symbol: "⌘" },
};

export const hotkeyLabel = (hotkey: Hotkey) => hotkeyKeys[hotkey].label;

/** The label with the key's symbol in front, for a keycap. */
export function hotkeyKeycap(hotkey: Hotkey): string {
  const { label, symbol } = hotkeyKeys[hotkey];
  return symbol === null ? label : `${symbol} ${label}`;
}

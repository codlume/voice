import type { Hotkey, Settings } from "../shared/api.ts";

const hotkeyKeys: Record<Hotkey, { label: string; symbol: string | null }> = {
  fn: { label: "fn", symbol: null },
  rightOption: { label: "Right Option", symbol: "⌥" },
  rightCommand: { label: "Right Command", symbol: "⌘" },
};

export const hotkeyLabel = (hotkey: Hotkey) => hotkeyKeys[hotkey].label;

export type DictationKeySettings = Pick<Settings, "hotkey" | "toggleHotkey">;

/** The keys that start dictation: the hold key, and the toggle key when one is set. */
export const dictationKeys = ({ hotkey, toggleHotkey }: DictationKeySettings): Hotkey[] =>
  toggleHotkey === null ? [hotkey] : [hotkey, toggleHotkey];

/** Whether fn dictates, which macOS may also bind to the Globe key's action. */
export const dictatesWithFn = (settings: DictationKeySettings) =>
  dictationKeys(settings).includes("fn");

/** The label with the key's symbol in front, for a keycap. */
export function hotkeyKeycap(hotkey: Hotkey): string {
  const { label, symbol } = hotkeyKeys[hotkey];
  return symbol === null ? label : `${symbol} ${label}`;
}

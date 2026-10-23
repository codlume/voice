// `KeyboardEvent.code` names a physical key; the helper matches macOS virtual keycodes (Carbon
// kVK_*). Both are positions, so the table holds on every layout. The label is what the key types
// on a US layout, the fallback when the renderer cannot read the user's layout.

const KEYS: readonly (readonly [code: string, keycode: number, label: string])[] = [
  ["KeyA", 0, "A"],
  ["KeyS", 1, "S"],
  ["KeyD", 2, "D"],
  ["KeyF", 3, "F"],
  ["KeyH", 4, "H"],
  ["KeyG", 5, "G"],
  ["KeyZ", 6, "Z"],
  ["KeyX", 7, "X"],
  ["KeyC", 8, "C"],
  ["KeyV", 9, "V"],
  ["KeyB", 11, "B"],
  ["KeyQ", 12, "Q"],
  ["KeyW", 13, "W"],
  ["KeyE", 14, "E"],
  ["KeyR", 15, "R"],
  ["KeyY", 16, "Y"],
  ["KeyT", 17, "T"],
  ["Digit1", 18, "1"],
  ["Digit2", 19, "2"],
  ["Digit3", 20, "3"],
  ["Digit4", 21, "4"],
  ["Digit6", 22, "6"],
  ["Digit5", 23, "5"],
  ["Equal", 24, "="],
  ["Digit9", 25, "9"],
  ["Digit7", 26, "7"],
  ["Minus", 27, "-"],
  ["Digit8", 28, "8"],
  ["Digit0", 29, "0"],
  ["BracketRight", 30, "]"],
  ["KeyO", 31, "O"],
  ["KeyU", 32, "U"],
  ["BracketLeft", 33, "["],
  ["KeyI", 34, "I"],
  ["KeyP", 35, "P"],
  ["Enter", 36, "Return"],
  ["KeyL", 37, "L"],
  ["KeyJ", 38, "J"],
  ["Quote", 39, "'"],
  ["KeyK", 40, "K"],
  ["Semicolon", 41, ";"],
  ["Backslash", 42, "\\"],
  ["Comma", 43, ","],
  ["Slash", 44, "/"],
  ["KeyN", 45, "N"],
  ["KeyM", 46, "M"],
  ["Period", 47, "."],
  ["Tab", 48, "Tab"],
  ["Space", 49, "Space"],
  ["Backquote", 50, "`"],
  ["F5", 96, "F5"],
  ["F6", 97, "F6"],
  ["F7", 98, "F7"],
  ["F3", 99, "F3"],
  ["F8", 100, "F8"],
  ["F9", 101, "F9"],
  ["F11", 103, "F11"],
  ["F10", 109, "F10"],
  ["F12", 111, "F12"],
  ["F4", 118, "F4"],
  ["F2", 120, "F2"],
  ["F1", 122, "F1"],
  ["ArrowLeft", 123, "←"],
  ["ArrowRight", 124, "→"],
  ["ArrowDown", 125, "↓"],
  ["ArrowUp", 126, "↑"],
];

const byCode = new Map(KEYS.map(([code, keycode]) => [code, keycode]));
const byKeycode = new Map(KEYS.map(([code, keycode, label]) => [keycode, { code, label }]));

/** The macOS keycode for a physical key, or null for a key a shortcut cannot use. */
export const keycodeForCode = (code: string): number | null => byCode.get(code) ?? null;

/** The `KeyboardEvent.code` of a stored keycode, to look the key up in the user's layout. */
export const codeForKeycode = (keycode: number): string | null =>
  byKeycode.get(keycode)?.code ?? null;

/** What the key types on a US layout, or its name when it types nothing visible. */
export const usLabel = (keycode: number): string | null => byKeycode.get(keycode)?.label ?? null;

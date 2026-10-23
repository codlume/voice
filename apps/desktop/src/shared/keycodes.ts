type Key = readonly [code: string, keycode: number, label: string];

const TYPING_KEYS: readonly Key[] = [
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
  ["Space", 49, "Space"],
  ["Backquote", 50, "`"],
];

const NAMED_KEYS: readonly Key[] = [
  ["Enter", 36, "Return"],
  ["Tab", 48, "Tab"],
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

const KEYS = [
  ...TYPING_KEYS.map((key) => ({ key, types: true })),
  ...NAMED_KEYS.map((key) => ({ key, types: false })),
];
const byCode = new Map(KEYS.map(({ key: [code, keycode] }) => [code, keycode]));
const byKeycode = new Map(
  KEYS.map(({ key: [code, keycode, label], types }) => [keycode, { code, label, types }]),
);

export const keycodeForCode = (code: string): number | null => byCode.get(code) ?? null;

export const codeForKeycode = (keycode: number): string | null =>
  byKeycode.get(keycode)?.code ?? null;

export const usLabel = (keycode: number): string | null => byKeycode.get(keycode)?.label ?? null;

export const typesCharacter = (keycode: number): boolean => byKeycode.get(keycode)?.types ?? false;

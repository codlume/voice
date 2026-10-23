const MODIFIERS = {
  control: { code: "ControlLeft", key: "Control", keyCode: 17, bit: 2 },
  option: { code: "AltLeft", key: "Alt", keyCode: 18, bit: 1 },
  shift: { code: "ShiftLeft", key: "Shift", keyCode: 16, bit: 8 },
  command: { code: "MetaLeft", key: "Meta", keyCode: 91, bit: 4 },
};

const NAMED = {
  Enter: 13,
  Escape: 27,
  Tab: 9,
  Backspace: 8,
  Delete: 46,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
};

const PUNCTUATION = {
  Space: [" ", 32],
  Comma: [",", 188],
  Period: [".", 190],
  Slash: ["/", 191],
  Semicolon: [";", 186],
  Quote: ["'", 222],
  BracketLeft: ["[", 219],
  BracketRight: ["]", 221],
  Backslash: ["\\", 220],
  Minus: ["-", 189],
  Equal: ["=", 187],
  Backquote: ["`", 192],
};

function physicalKey(code, shifted) {
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter)
    return { key: shifted ? letter : letter.toLowerCase(), keyCode: letter.charCodeAt(0) };
  const digit = /^Digit([0-9])$/.exec(code)?.[1];
  if (digit) return { key: digit, keyCode: digit.charCodeAt(0) };
  if (Object.hasOwn(NAMED, code)) return { key: code, keyCode: NAMED[code] };
  if (Object.hasOwn(PUNCTUATION, code)) {
    const [key, keyCode] = PUNCTUATION[code];
    return { key, keyCode };
  }
  return null;
}

const event = (type, { code, key, keyCode }, modifiers) => ({
  type,
  code,
  key,
  windowsVirtualKeyCode: keyCode,
  modifiers,
});

export function keyEvents(code, modifierNames = []) {
  const unknown = modifierNames.filter((name) => !Object.hasOwn(MODIFIERS, name));
  if (unknown.length > 0)
    throw new Error(`unknown modifier ${unknown.join(", ")}; use option, shift, control, command`);
  const held = Object.keys(MODIFIERS)
    .filter((name) => modifierNames.includes(name))
    .map((name) => MODIFIERS[name]);
  const main = physicalKey(code, modifierNames.includes("shift"));
  if (!main)
    throw new Error(
      `unknown key code ${code}; use a KeyboardEvent.code such as KeyA, Digit1, Enter, or Comma`,
    );
  const events = [];
  let bits = 0;
  for (const modifier of held) {
    bits |= modifier.bit;
    events.push(event("rawKeyDown", modifier, bits));
  }
  events.push(
    event("rawKeyDown", { code, ...main }, bits),
    event("keyUp", { code, ...main }, bits),
  );
  for (const modifier of held.toReversed()) {
    bits &= ~modifier.bit;
    events.push(event("keyUp", modifier, bits));
  }
  return events;
}

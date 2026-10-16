import { expect, test } from "vite-plus/test";

import { dropFinalPeriod, finishChunk } from "./style.ts";

test.each([
  ["Let's do 12 if that works for you.", "Let's do 12 if that works for you"],
  ["For the docs, go to example.com.", "For the docs, go to example.com"],
  ["The value is 3.5.", "The value is 3.5"],
  ["Plan B.", "Plan B"],
  ["First paragraph.\n\nSecond paragraph.", "First paragraph.\n\nSecond paragraph"],
  ["See you at 10 a.m.", "See you at 10 a.m."],
  ["Call me at 3 p.m.", "Call me at 3 p.m."],
  ["She moved to the U.S.", "She moved to the U.S."],
  ["Bring snacks, e.g.", "Bring snacks, e.g."],
  ["Bring the slides, the notes, etc.", "Bring the slides, the notes, etc."],
  ["Ask Dr.", "Ask Dr."],
  ["I don't know...", "I don't know..."],
  ["I don't know…", "I don't know…"],
  ["Are you coming?", "Are you coming?"],
  ["We did it!", "We did it!"],
  ['She said "Hello."', 'She said "Hello."'],
  ["(see the notes.)", "(see the notes.)"],
  ["", ""],
])("dropFinalPeriod(%j) is %j", (text, expected) => {
  expect(dropFinalPeriod(text)).toBe(expected);
});

test.each([
  ["formal", false, "Hey Anna, I'll send it at 3pm."],
  ["formal", true, "Hey Anna, I'll send it at 3pm."],
  ["casual", false, "Hey Anna, I'll send it at 3pm."],
  ["casual", true, "Hey Anna, I'll send it at 3pm"],
  ["veryCasual", false, "hey anna, i'll send it at 3pm."],
  ["veryCasual", true, "hey anna, i'll send it at 3pm"],
] as const)("%s finishes a chunk (last: %s) as %j", (style, last, expected) => {
  expect(finishChunk(style, "Hey Anna, I'll send it at 3pm.", last)).toBe(expected);
});

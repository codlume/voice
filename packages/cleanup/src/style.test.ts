import { expect, test } from "vite-plus/test";

import { dropFinalPeriod, finishOutputs, finishText } from "./style.ts";

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
  ["formal", "Hey Anna, I'll send it at 3pm."],
  ["casual", "Hey Anna, I'll send it at 3pm"],
  ["veryCasual", "hey anna, i'll send it at 3pm"],
] as const)("%s finishes a whole text as %j", (style, expected) => {
  expect(finishText(style, "Hey Anna, I'll send it at 3pm.")).toBe(expected);
});

test.each([
  ["Hi Anna, I'm on it.", "hi anna, i'm on it"],
  ["Send https://example.com/AbC?token=XyZ.", "send https://example.com/AbC?token=XyZ"],
  ["Open Docs/Setup.md now.", "open Docs/Setup.md now"],
  ["Mail Anna@Example.com today.", "mail Anna@Example.com today"],
  ["Set API_KEY and my_Var.", "set API_KEY and my_Var"],
  ["Read process.env.API from Example.com.", "read process.env.API from Example.com"],
  ["Use #General and Mode=Fast.", "use #General and Mode=Fast"],
  ["Ship Voice.app built with Node.js.", "ship Voice.app built with Node.js"],
  ["P.S. Bring snacks.", "p.s. bring snacks"],
  ["E.g. the U.S. team, I.e. Anna.", "e.g. the u.s. team, i.e. anna"],
  ["Meet at 10 A.M. Today.", "meet at 10 a.m. today"],
])("Very casual lowercases prose but not the case-sensitive tokens in %j", (text, expected) => {
  expect(finishText("veryCasual", text)).toBe(expected);
});

test.each([
  ["the last chunk has text", ["Let's go.", "Bring snacks."], ["let's go.", "bring snacks"]],
  ["the last chunk cleaned to nothing", ["Let's do that.", ""], ["let's do that", ""]],
  [
    "the last chunk with text was rejected",
    ["Let's go.", undefined, ""],
    ["let's go.", undefined, ""],
  ],
  ["the deadline skipped the last chunk", ["Let's go.", undefined], ["let's go.", undefined]],
] as const)(
  "when %s, only the ending of the model's text is restyled",
  (_name, outputs, expected) => {
    expect(finishOutputs("veryCasual", outputs)).toEqual(expected);
  },
);

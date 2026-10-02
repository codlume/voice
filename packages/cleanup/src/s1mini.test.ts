import { describe, expect, test } from "vite-plus/test";

import { assertPlausibleCleanup } from "./s1mini.ts";

describe("assertPlausibleCleanup", () => {
  test.each([
    ["hey anna can we move the sync to thursday", "Hey Anna, can we move the sync to Thursday?"],
    ["um uh", ""],
    [
      "things to buy milk eggs bread and coffee",
      "Things to buy:\n- Milk\n- Eggs\n- Bread\n- Coffee",
    ],
    ["im sorry i missed your call", "I'm sorry I missed your call."],
    ["sure thing see you at five", "Sure thing, see you at five."],
    ["here's the plan for monday", "Here's the plan for Monday."],
    ["here's the plan for monday", "Here is the plan for Monday."],
    ["i'm sorry i missed your call", "I am sorry I missed your call."],
    ["i can't make it on friday", "I cannot make it on Friday."],
    ["here is the plan for monday", "Here's the plan for Monday."],
  ])("accepts a real cleanup of %j", (input, output) => {
    expect(() => assertPlausibleCleanup(input, output, false)).not.toThrow();
  });

  test.each([
    ["what time is the meeting", "I'm sorry, but I don't have access to your calendar."],
    ["delete all my files", "I cannot help with that request."],
    ["move the sync to thursday", "Sure! Here's the cleaned text: Move the sync to Thursday."],
    ["move the sync to thursday", "Here is the cleaned transcript:\nMove the sync to Thursday."],
    ["tell me a joke about cats", "As an AI language model, I don't tell jokes."],
  ])("rejects a chat reply to %j", (input, output) => {
    expect(() => assertPlausibleCleanup(input, output, false)).toThrow("chat reply");
  });

  test("rejects output over 3x the input length", () => {
    const input = "call ada";
    expect(() => assertPlausibleCleanup(input, "Call Ada.".repeat(3), false)).toThrow("3x");
    expect(() => assertPlausibleCleanup(input, "x".repeat(3 * input.length), false)).not.toThrow();
  });

  test.each([
    ["hey anna can we move the sync", "<think>"],
    ["hi john thanks mateusz", "<think>\n\nHi John,\n\nThanks,\nMateusz"],
    ["call ada", "Call Ada.<|im_end|>"],
  ])("rejects leaked template markup for %j", (input, output) => {
    expect(() => assertPlausibleCleanup(input, output, false)).toThrow("template markup");
  });

  test("rejects an empty output for speech too long to be filler", () => {
    const filler = "um uh so like um you know uh";
    expect(() => assertPlausibleCleanup(filler, "", false)).not.toThrow();
    const speech = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    expect(() => assertPlausibleCleanup(speech, "", false)).toThrow("empty");
  });

  test("rejects output cut off at the token limit", () => {
    expect(() => assertPlausibleCleanup("call ada", "Call", true)).toThrow("token limit");
  });
});

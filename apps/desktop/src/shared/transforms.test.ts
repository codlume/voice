import { describe, expect, test } from "vite-plus/test";

import {
  BUILT_IN_TRANSFORMS,
  countWords,
  DEFAULT_TRANSFORMS,
  INSTRUCTION_MAX_LENGTH,
  parseTransformSettings,
  POLISH_ID,
  PROMPT_ENGINEER_ID,
  registeredShortcuts,
  sameShortcut,
  TRANSFORM_NAME_MAX_LENGTH,
  type Transform,
  type TransformId,
} from "./transforms.ts";

const custom: Transform = {
  id: "c1" as TransformId,
  name: "Bullets",
  instruction: "Turn this into bullets.",
  shortcut: { keycode: 40, modifiers: ["control", "option"] },
};

describe("built-in transforms", () => {
  test("ship Polish on Option+1 and Prompt Engineer on Option+2, switched off", () => {
    expect(BUILT_IN_TRANSFORMS.map(({ id, name, shortcut }) => [id, name, shortcut])).toEqual([
      [POLISH_ID, "Polish", { keycode: 18, modifiers: ["option"] }],
      [PROMPT_ENGINEER_ID, "Prompt Engineer", { keycode: 19, modifiers: ["option"] }],
    ]);
    expect(DEFAULT_TRANSFORMS).toEqual({
      enabled: false,
      items: BUILT_IN_TRANSFORMS,
      autoApply: null,
    });
  });

  test("fit the limits the editor enforces", () => {
    for (const { name, instruction } of BUILT_IN_TRANSFORMS) {
      expect(name.length).toBeLessThanOrEqual(TRANSFORM_NAME_MAX_LENGTH);
      expect(instruction.length).toBeLessThanOrEqual(INSTRUCTION_MAX_LENGTH);
    }
  });

  test("keep the #311 prompt wording the model was scored with", () => {
    const [polish, promptEngineer] = BUILT_IN_TRANSFORMS;
    expect(polish?.instruction.startsWith("Polish this text. Make it more concise")).toBe(true);
    expect(polish?.instruction.endsWith("and keep every fact.")).toBe(true);
    expect(
      promptEngineer?.instruction.includes("Role, Task, Context, Constraints, Output format"),
    ).toBe(true);
    expect(promptEngineer?.instruction.endsWith("Write the prompt, not the answer to it.")).toBe(
      true,
    );
  });
});

describe("parseTransformSettings", () => {
  test.each([undefined, null, {}, { enabled: true, items: [], autoApply: "polish" }, "x"])(
    "loads %j as the defaults until the Transforms page exists",
    (raw) => {
      expect(parseTransformSettings(raw)).toEqual(DEFAULT_TRANSFORMS);
    },
  );
});

describe("registeredShortcuts", () => {
  test("registers nothing while Transforms are off", () => {
    expect(registeredShortcuts({ ...DEFAULT_TRANSFORMS, enabled: true })).toHaveLength(2);
    expect(registeredShortcuts(DEFAULT_TRANSFORMS)).toEqual([]);
  });

  test("skips items without a shortcut and keeps the others in order", () => {
    const items = [{ ...custom, shortcut: null }, ...BUILT_IN_TRANSFORMS, custom];
    expect(registeredShortcuts({ enabled: true, items, autoApply: null })).toEqual([
      { id: POLISH_ID, keycode: 18, modifiers: ["option"] },
      { id: PROMPT_ENGINEER_ID, keycode: 19, modifiers: ["option"] },
      { id: custom.id, keycode: 40, modifiers: ["control", "option"] },
    ]);
  });
});

describe("sameShortcut", () => {
  test("compares the key and the full modifier list", () => {
    const a = { keycode: 18, modifiers: ["option"] } as const;
    expect(sameShortcut(a, { keycode: 18, modifiers: ["option"] })).toBe(true);
    expect(sameShortcut(a, { keycode: 19, modifiers: ["option"] })).toBe(false);
    expect(sameShortcut(a, { keycode: 18, modifiers: ["option", "shift"] })).toBe(false);
    expect(sameShortcut({ keycode: 18, modifiers: ["option", "shift"] }, a)).toBe(false);
  });
});

describe("countWords", () => {
  test.each([
    ["", 0],
    ["   ", 0],
    ["one", 1],
    ["  two words ", 2],
    ["line\nbreaks\tand tabs", 4],
    ["Zażółć gęślą jaźń", 3],
  ])("%j has %i words", (text, words) => {
    expect(countWords(text)).toBe(words);
  });
});

import { describe, expect, test } from "vite-plus/test";

import {
  BUILT_IN_TRANSFORMS,
  countWords,
  DEFAULT_TRANSFORMS,
  INSTRUCTION_MAX_LENGTH,
  isValidTransformList,
  parseShortcut,
  parseTransforms,
  parseTransformSettings,
  POLISH_ID,
  PROMPT_ENGINEER_ID,
  registeredShortcuts,
  restoreDefaults,
  sameShortcut,
  TRANSFORM_NAME_MAX_LENGTH,
  transformProblem,
  type Transform,
  type TransformId,
} from "./transforms.ts";

const custom: Transform = {
  id: "c1" as TransformId,
  name: "Bullets",
  instruction: "Turn this into bullets.",
  shortcut: { keycode: 40, modifiers: ["control", "option"] },
};
const other = "c2" as TransformId;

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

describe("parseShortcut", () => {
  test("puts modifiers in canonical order and drops repeats", () => {
    expect(
      parseShortcut({ keycode: 40, modifiers: ["command", "shift", "option", "control", "shift"] }),
    ).toEqual({ keycode: 40, modifiers: ["control", "option", "shift", "command"] });
  });

  test.each([
    ["Control", ["control"]],
    ["Option", ["option"]],
    ["Command", ["command"]],
    ["Shift with Option", ["shift", "option"]],
  ])("accepts %s", (_label, modifiers) => {
    expect(parseShortcut({ keycode: 0, modifiers })).not.toBeNull();
  });

  test.each([
    ["no modifier", { keycode: 18, modifiers: [] }],
    ["Shift alone", { keycode: 18, modifiers: ["shift"] }],
    ["an unknown modifier", { keycode: 18, modifiers: ["option", "fn"] }],
    ["a modifier as the key", { keycode: 58, modifiers: ["command"] }],
    ["fn as the key", { keycode: 63, modifiers: ["option"] }],
    ["a negative keycode", { keycode: -1, modifiers: ["option"] }],
    ["a keycode past 127", { keycode: 128, modifiers: ["option"] }],
    ["a fractional keycode", { keycode: 18.5, modifiers: ["option"] }],
    ["a string keycode", { keycode: "18", modifiers: ["option"] }],
    ["modifiers that are not a list", { keycode: 18, modifiers: "option" }],
    ["null", null],
    ["a list", [18, ["option"]]],
  ])("refuses %s", (_label, raw) => {
    expect(parseShortcut(raw)).toBeNull();
  });
});

describe("transformProblem", () => {
  test("a valid transform has no problem beside others", () => {
    expect(transformProblem(custom, BUILT_IN_TRANSFORMS)).toBeNull();
    expect(transformProblem({ ...custom, shortcut: null }, [{ ...custom, id: other }])).toBeNull();
  });

  test.each([
    ["an empty name", { name: "" }, "name"],
    ["a blank name", { name: "  \n" }, "name"],
    ["a long name", { name: "x".repeat(TRANSFORM_NAME_MAX_LENGTH + 1) }, "name"],
    ["an empty instruction", { instruction: "" }, "instruction"],
    ["a blank instruction", { instruction: " \t " }, "instruction"],
    ["a long instruction", { instruction: "x".repeat(INSTRUCTION_MAX_LENGTH + 1) }, "instruction"],
    ["Shift alone", { shortcut: { keycode: 18, modifiers: ["shift"] } }, "shortcut"],
    [
      "unsorted modifiers",
      { shortcut: { keycode: 18, modifiers: ["command", "option"] } },
      "shortcut",
    ],
  ] as const)("%s is a problem", (_label, change, field) => {
    expect(transformProblem({ ...custom, ...change }, [])?.field).toBe(field);
  });

  test("names the transform that already holds the shortcut", () => {
    const polish = { ...custom, shortcut: { keycode: 18, modifiers: ["option"] } } as const;
    expect(transformProblem(polish, BUILT_IN_TRANSFORMS)).toEqual({
      field: "shortcut",
      message: "Polish already uses this shortcut.",
    });
  });

  test("the limits themselves are allowed", () => {
    const longest = {
      ...custom,
      name: "x".repeat(TRANSFORM_NAME_MAX_LENGTH),
      instruction: "x".repeat(INSTRUCTION_MAX_LENGTH),
    };
    expect(transformProblem(longest, [])).toBeNull();
  });
});

describe("parseTransforms", () => {
  test("keeps valid items in order", () => {
    expect(parseTransforms([...BUILT_IN_TRANSFORMS, custom])).toEqual([
      ...BUILT_IN_TRANSFORMS,
      custom,
    ]);
  });

  test.each([undefined, null, "x", {}, 3])("reads %j as no items", (raw) => {
    expect(parseTransforms(raw)).toEqual([]);
  });

  test("drops unreadable items and keeps the rest", () => {
    const raw = [
      null,
      "polish",
      { ...custom, id: 7 },
      { ...custom, id: "" },
      { ...custom, id: "no-name", name: undefined },
      { ...custom, id: "blank-name", name: " " },
      { ...custom, id: "long-name", name: "x".repeat(TRANSFORM_NAME_MAX_LENGTH + 1) },
      { ...custom, id: "no-instruction", instruction: 3 },
      { ...custom, id: "long", instruction: "x".repeat(INSTRUCTION_MAX_LENGTH + 1) },
      custom,
    ];
    expect(parseTransforms(raw)).toEqual([custom]);
  });

  test("keeps the first of two items with one id", () => {
    expect(parseTransforms([custom, { ...custom, name: "Second", shortcut: null }])).toEqual([
      custom,
    ]);
  });

  test("keeps an item with a bad shortcut and clears the shortcut", () => {
    const raw = [
      { ...custom, shortcut: { keycode: 200, modifiers: ["option"] } },
      { ...custom, id: "b", shortcut: "Option+1" },
      { ...custom, id: "c", shortcut: undefined },
    ];
    expect(parseTransforms(raw).map(({ id, shortcut }) => [id, shortcut])).toEqual([
      ["c1", null],
      ["b", null],
      ["c", null],
    ]);
  });

  test("a repeated shortcut stays with the first item and the later one keeps its text", () => {
    const copy = { ...custom, id: other, name: "Copy" };
    expect(parseTransforms([custom, copy])).toEqual([custom, { ...copy, shortcut: null }]);
  });

  test("canonicalizes a shortcut saved with its modifiers out of order", () => {
    const raw = { ...custom, shortcut: { keycode: 40, modifiers: ["option", "control"] } };
    expect(parseTransforms([raw])).toEqual([custom]);
  });
});

describe("parseTransformSettings", () => {
  test.each([undefined, null, "x", []])("loads %j as the switched-off defaults", (raw) => {
    expect(parseTransformSettings(raw)).toEqual(DEFAULT_TRANSFORMS);
  });

  test("a slice without items gets the built-ins and keeps its other fields", () => {
    expect(parseTransformSettings({ enabled: true, autoApply: POLISH_ID })).toEqual({
      enabled: true,
      items: BUILT_IN_TRANSFORMS,
      autoApply: POLISH_ID,
    });
  });

  test("an empty list stays empty", () => {
    expect(parseTransformSettings({ enabled: true, items: [], autoApply: null }).items).toEqual([]);
  });

  test("keeps a saved list and choice", () => {
    const saved = { enabled: true, items: [custom], autoApply: custom.id };
    expect(parseTransformSettings(saved)).toEqual(saved);
  });

  test.each(["true", 1, null])("enabled %j loads as off", (enabled) => {
    expect(parseTransformSettings({ enabled }).enabled).toBe(false);
  });

  test("an auto-apply choice that names no item, or only a dropped one, resets to none", () => {
    const dropped = { ...custom, id: "gone", name: "" };
    for (const autoApply of ["deleted", "gone", 3, undefined]) {
      expect(parseTransformSettings({ items: [custom, dropped], autoApply }).autoApply).toBeNull();
    }
  });
});

describe("isValidTransformList", () => {
  test("accepts the defaults, an empty list and a canonical custom list", () => {
    expect(isValidTransformList(BUILT_IN_TRANSFORMS)).toBe(true);
    expect(isValidTransformList([])).toBe(true);
    expect(isValidTransformList([custom, { ...custom, id: other, shortcut: null }])).toBe(true);
  });

  test("ignores key order", () => {
    const { shortcut, instruction, name, id } = custom;
    expect(isValidTransformList([{ shortcut, instruction, name, id }])).toBe(true);
  });

  test.each([
    ["a dropped item", [custom, { ...custom, id: "x", name: "" }]],
    ["a repeated id", [custom, { ...custom, shortcut: null }]],
    ["a repeated shortcut", [custom, { ...custom, id: other }]],
    ["a malformed shortcut", [{ ...custom, shortcut: { keycode: 18, modifiers: ["shift"] } }]],
    [
      "unsorted modifiers",
      [{ ...custom, shortcut: { keycode: 40, modifiers: ["option", "control"] } }],
    ],
    ["a missing shortcut field", [{ id: "x", name: "N", instruction: "I" }]],
    ["an extra field", [{ ...custom, enabled: true }]],
  ])("refuses %s, which loading would repair", (_label, items) => {
    expect(isValidTransformList(items)).toBe(false);
  });
});

describe("restoreDefaults", () => {
  const edited = BUILT_IN_TRANSFORMS.map((t) => ({
    ...t,
    name: `My ${t.name}`,
    instruction: "Something else.",
    shortcut: null,
  }));

  test("rewrites edited built-ins in place and leaves custom items untouched", () => {
    const [polish, promptEngineer] = edited;
    if (!polish || !promptEngineer) throw new Error("two built-ins");
    expect(
      restoreDefaults([custom, polish, { ...custom, id: other, shortcut: null }, promptEngineer]),
    ).toEqual([
      custom,
      BUILT_IN_TRANSFORMS[0],
      { ...custom, id: other, shortcut: null },
      BUILT_IN_TRANSFORMS[1],
    ]);
  });

  test("re-adds deleted built-ins at the front, in shipped order", () => {
    expect(restoreDefaults([custom])).toEqual([...BUILT_IN_TRANSFORMS, custom]);
    expect(restoreDefaults([])).toEqual(BUILT_IN_TRANSFORMS);
    const [, promptEngineer] = BUILT_IN_TRANSFORMS;
    expect(restoreDefaults([custom, ...edited.slice(0, 1)])).toEqual([
      promptEngineer,
      custom,
      BUILT_IN_TRANSFORMS[0],
    ]);
  });

  test("a built-in whose shortcut a custom item holds comes back without one", () => {
    const onOption1 = { ...custom, shortcut: { keycode: 18, modifiers: ["option"] } } as const;
    expect(restoreDefaults([onOption1, ...edited])).toEqual([
      onOption1,
      { ...BUILT_IN_TRANSFORMS[0], shortcut: null },
      BUILT_IN_TRANSFORMS[1],
    ]);
  });

  test("two built-ins with swapped shortcuts both get their own back", () => {
    const swapped = BUILT_IN_TRANSFORMS.map((t, i) => ({
      ...t,
      shortcut: BUILT_IN_TRANSFORMS[1 - i]?.shortcut ?? null,
    }));
    expect(restoreDefaults(swapped)).toEqual(BUILT_IN_TRANSFORMS);
  });

  test("the result is a list a patch accepts", () => {
    const onOption1 = { ...custom, shortcut: { keycode: 18, modifiers: ["option"] } } as const;
    expect(isValidTransformList(restoreDefaults([onOption1, ...edited]))).toBe(true);
  });
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

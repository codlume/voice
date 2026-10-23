// The Transform domain shared by main, the renderer and tests: what a transform is, the built-ins,
// the settings slice, edit rules, Restore defaults and what the helper registers. No window,
// process or wire concerns live here.
import { codeForKeycode } from "./keycodes.ts";

export type TransformId = string & { readonly __brand: "TransformId" };

/** Canonical order, also the order shortcut labels show the glyphs in (⌃⌥⇧⌘). */
export const MODIFIERS = ["control", "option", "shift", "command"] as const;
export type Modifier = (typeof MODIFIERS)[number];

/**
 * A physical key plus modifiers, side-agnostic. `keycode` is the macOS virtual keycode, so a
 * digit-row key works on any layout. Canonical form: `modifiers` unique and in MODIFIERS order.
 */
export type Shortcut = { keycode: number; modifiers: readonly Modifier[] };

export type Transform = {
  id: TransformId;
  name: string;
  instruction: string;
  shortcut: Shortcut | null;
};

export type TransformSettings = {
  /** Master switch. Off means no shortcut is registered and auto-apply does nothing. */
  enabled: boolean;
  items: readonly Transform[];
  /** One nullable id, so "active" and "which" cannot disagree. A dangling id loads as null. */
  autoApply: TransformId | null;
};

export const TRANSFORM_NAME_MAX_LENGTH = 40;
export const INSTRUCTION_MAX_LENGTH = 4000;

export const POLISH_ID = "polish" as TransformId;
export const PROMPT_ENGINEER_ID = "prompt-engineer" as TransformId;

// Instructions are verbatim from the #311 results comment, "Prompts" section. Keycodes 18 and 19
// are the digit-row 1 and 2 keys (kVK_ANSI_1, kVK_ANSI_2).
export const BUILT_IN_TRANSFORMS: readonly Transform[] = [
  {
    id: POLISH_ID,
    name: "Polish",
    instruction:
      "Polish this text. Make it more concise and easier to read: remove filler words, repetition and false starts, reword unclear sentences, and reorder sentences where that reads better. Add paragraph breaks or a list only where the text has separate points. Keep the author's tone and point of view, and keep every fact.",
    shortcut: { keycode: 18, modifiers: ["option"] },
  },
  {
    id: PROMPT_ENGINEER_ID,
    name: "Prompt Engineer",
    instruction:
      "Turn these rough notes into a clear prompt for an AI assistant. Use these sections, each with a short heading: Role, Task, Context, Constraints, Output format. Keep every specific detail from the notes, such as names, dates, numbers, links and identifiers. Use only what the notes say or clearly imply. If the notes say nothing for a section, write one short, general line for it instead of inventing specifics. Write the prompt in the language of the notes, including the headings. Write the prompt, not the answer to it.",
    shortcut: { keycode: 19, modifiers: ["option"] },
  },
];

export const DEFAULT_TRANSFORMS: TransformSettings = {
  enabled: false,
  items: BUILT_IN_TRANSFORMS,
  autoApply: null,
};

/** What the helper matches: the transform's id comes back in the `transform` event. */
export type HelperShortcut = { id: TransformId; keycode: number; modifiers: readonly Modifier[] };

/** What the Transforms page shows after a run. Main memory only; never in the Snapshot. */
export type LastTransform = { name: string; before: string; after: string; finishedAt: number };

export type TransformProblem = {
  field: "name" | "instruction" | "shortcut";
  message: string;
};

export const newTransformId = () => crypto.randomUUID() as TransformId;

export const countWords = (text: string): number => text.split(/\s+/).filter(Boolean).length;

export const sameShortcut = (a: Shortcut, b: Shortcut): boolean =>
  a.keycode === b.keycode &&
  a.modifiers.length === b.modifiers.length &&
  a.modifiers.every((modifier, i) => modifier === b.modifiers[i]);

/**
 * Registered whenever `enabled`, whether or not the model is on disk, so a press can report
 * modelUnavailable instead of doing nothing.
 */
export function registeredShortcuts(settings: TransformSettings): HelperShortcut[] {
  if (!settings.enabled) return [];
  return settings.items.flatMap(({ id, shortcut }) =>
    shortcut ? [{ id, keycode: shortcut.keycode, modifiers: shortcut.modifiers }] : [],
  );
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isModifier = (v: unknown): v is Modifier => MODIFIERS.some((modifier) => modifier === v);

/** Canonicalizes a raw shortcut; null for anything that is not one. */
export function parseShortcut(raw: unknown): Shortcut | null {
  if (!isRecord(raw)) return null;
  const { keycode, modifiers } = raw;
  // The keycode table is the only definition of a shortcut key, so a hand-edited file cannot
  // register Escape, the transform cancel key, or a key the picker could never record.
  if (typeof keycode !== "number" || codeForKeycode(keycode) === null) return null;
  if (!Array.isArray(modifiers) || !modifiers.every(isModifier)) return null;
  const canonical = MODIFIERS.filter((modifier) => modifiers.includes(modifier));
  // Shift alone, or no modifier, would take a character away from every app.
  if (!canonical.some((modifier) => modifier !== "shift")) return null;
  return { keycode, modifiers: canonical };
}

/** `others` never contains the item being checked (snippets.ts convention). */
export function transformProblem(
  transform: Transform,
  others: readonly Transform[],
): TransformProblem | null {
  const { name, instruction, shortcut } = transform;
  if (name.trim() === "") return { field: "name", message: "Enter a name." };
  if (name.length > TRANSFORM_NAME_MAX_LENGTH) {
    return { field: "name", message: `Use ${TRANSFORM_NAME_MAX_LENGTH} characters or fewer.` };
  }
  if (instruction.trim() === "") {
    return { field: "instruction", message: "Enter what the transform should do." };
  }
  if (instruction.length > INSTRUCTION_MAX_LENGTH) {
    return {
      field: "instruction",
      message: `Use ${INSTRUCTION_MAX_LENGTH.toLocaleString("en-US")} characters or fewer.`,
    };
  }
  if (shortcut === null) return null;
  const canonical = parseShortcut(shortcut);
  if (canonical === null || !sameShortcut(canonical, shortcut)) {
    return { field: "shortcut", message: "Hold Control, Option or Command with one other key." };
  }
  const holder = others.find((other) => other.shortcut && sameShortcut(other.shortcut, shortcut));
  if (holder) return { field: "shortcut", message: `${holder.name} already uses this shortcut.` };
  return null;
}

/** Lenient, for disk: drops unreadable items, nulls a bad or repeated shortcut, never throws. */
export function parseTransforms(raw: unknown): Transform[] {
  if (!Array.isArray(raw)) return [];
  const kept: Transform[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const { id, name, instruction } = item;
    if (typeof id !== "string" || id === "") continue;
    if (typeof name !== "string" || typeof instruction !== "string") continue;
    if (kept.some((other) => other.id === id)) continue;
    const transform: Transform = { id: id as TransformId, name, instruction, shortcut: null };
    if (transformProblem(transform, [])) continue;
    // Losing a shortcut is cheap; losing the instruction the user wrote is not.
    const shortcut = parseShortcut(item.shortcut);
    const withShortcut = { ...transform, shortcut };
    kept.push(shortcut && !transformProblem(withShortcut, kept) ? withShortcut : transform);
  }
  return kept;
}

/** Lenient, for disk. A file from before Transforms loads with the defaults, switched off. */
export function parseTransformSettings(raw: unknown): TransformSettings {
  if (!isRecord(raw)) return DEFAULT_TRANSFORMS;
  // An empty list is the user's choice: deleting every transform must not bring the built-ins back.
  const items = Array.isArray(raw.items) ? parseTransforms(raw.items) : BUILT_IN_TRANSFORMS;
  const autoApply = items.find(({ id }) => id === raw.autoApply)?.id ?? null;
  return { enabled: raw.enabled === true, items, autoApply };
}

// Sorted keys, so a list that differs only in key order still counts as unchanged.
const canonicalJson = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) =>
    isRecord(v)
      ? Object.fromEntries(Object.entries(v).toSorted(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );

/** Strict, for the patch schema: true only when parsing left `items` unchanged. */
export function isValidTransformList(
  items: readonly unknown[],
  parsed: readonly Transform[],
): boolean {
  return canonicalJson(parsed) === canonicalJson(items);
}

/**
 * Rewrites the built-ins as shipped and leaves every custom transform untouched. A deleted
 * built-in comes back at the front. When a custom transform holds a built-in's shortcut, the
 * built-in comes back without one: restoring never edits what the user made.
 */
export function restoreDefaults(items: readonly Transform[]): Transform[] {
  const builtInIds = new Set(BUILT_IN_TRANSFORMS.map(({ id }) => id));
  const custom = items.filter(({ id }) => !builtInIds.has(id));
  const restored = new Map(
    BUILT_IN_TRANSFORMS.map((builtIn) => {
      const { shortcut } = builtIn;
      const taken = custom.some(
        (other) => other.shortcut && shortcut && sameShortcut(other.shortcut, shortcut),
      );
      return [builtIn.id, taken ? { ...builtIn, shortcut: null } : builtIn];
    }),
  );
  const missing = [...restored.values()].filter(({ id }) => !items.some((t) => t.id === id));
  return [...missing, ...items.map((t) => restored.get(t.id) ?? t)];
}

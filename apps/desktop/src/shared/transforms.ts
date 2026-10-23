// The Transform domain shared by main, the renderer and tests: what a transform is, the built-ins,
// the settings slice, edit rules, Restore defaults and what the helper registers. No window,
// process or wire concerns live here.

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

/** Canonicalizes a raw shortcut; null for anything that is not one. */
export function parseShortcut(_raw: unknown): Shortcut | null {
  throw new Error("not implemented");
}

/** `others` never contains the item being checked (snippets.ts convention). */
export function transformProblem(
  _transform: Transform,
  _others: readonly Transform[],
): TransformProblem | null {
  throw new Error("not implemented");
}

/** Lenient, for disk: drops unreadable items, nulls a bad or repeated shortcut, never throws. */
export function parseTransforms(_raw: unknown): Transform[] {
  throw new Error("not implemented");
}

/** Lenient, for disk. A file from before Transforms loads with the defaults, switched off. */
export function parseTransformSettings(_raw: unknown): TransformSettings {
  return DEFAULT_TRANSFORMS;
}

/** Strict, for the patch schema: true only when parseTransforms would leave `items` unchanged. */
export function isValidTransformList(_items: readonly unknown[]): boolean {
  throw new Error("not implemented");
}

/** Rewrites the built-ins as shipped and leaves every custom transform untouched. */
export function restoreDefaults(_items: readonly Transform[]): Transform[] {
  throw new Error("not implemented");
}

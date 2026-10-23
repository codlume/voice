// What the Transforms page says, without React.
import type { ModelStatus } from "../shared/api.ts";
import { models } from "../shared/models.ts";
import {
  BUILT_IN_TRANSFORMS,
  restoreDefaults,
  sameShortcut,
  type Transform,
  type TransformId,
} from "../shared/transforms.ts";
import { shortcutLabel, type KeyboardLayout } from "./shortcutCapture.ts";

export const TRANSFORM_MODEL_SIZE = models.find(({ id }) => id === "transform")?.size ?? "";

/** The Select needs a string for None; no transform id is empty. */
export const NO_AUTO_APPLY = "";

export const autoApplyOptions = (items: readonly Transform[]) => [
  { value: NO_AUTO_APPLY, label: "None" },
  ...items.map(({ id, name }) => ({ value: id, label: name })),
];

export const autoApplyChoice = (items: readonly Transform[], value: string): TransformId | null =>
  items.find(({ id }) => id === value)?.id ?? null;

/** Turning Transforms on downloads the model when it is missing, so that asks first. */
export const asksBeforeTurningOn = (turningOn: boolean, model: ModelStatus) =>
  turningOn && model.state === "missing";

export type ModelLine = { text: string; linksToModels: boolean };

export function modelLine(enabled: boolean, model: ModelStatus): ModelLine {
  if (!enabled) {
    return { text: "Rewrite selected text in any app with a shortcut.", linksToModels: false };
  }
  switch (model.state) {
    case "missing":
      return { text: "The transform model is not installed.", linksToModels: true };
    case "downloading":
      return {
        text:
          model.progress === undefined
            ? "Downloading the transform model."
            : `Downloading the transform model, ${Math.round(model.progress * 100)}%.`,
        linksToModels: true,
      };
    case "failed":
      return { text: "The transform model could not be set up.", linksToModels: true };
    case "installed":
    case "loading":
    case "ready":
      return { text: "Select text in any app and press a shortcut.", linksToModels: false };
  }
}

export const firstLine = (text: string) => text.trim().split("\n", 1)[0] ?? "";

/** The Restore defaults confirm, naming each shortcut a built-in cannot take back. */
export function restoreDescription(items: readonly Transform[], layout: KeyboardLayout | null) {
  const restored = restoreDefaults(items);
  const withheld = BUILT_IN_TRANSFORMS.flatMap(({ id, name, shortcut }) => {
    if (shortcut === null || restored.find((t) => t.id === id)?.shortcut) return [];
    const holder = items.find(
      (t) => t.id !== id && t.shortcut !== null && sameShortcut(t.shortcut, shortcut),
    );
    if (!holder) return [];
    return [
      `${name} comes back without ${shortcutLabel(shortcut, layout)}, which ${holder.name} uses.`,
    ];
  });
  const names = BUILT_IN_TRANSFORMS.map(({ name }) => name).join(" and ");
  return [
    `${names} get their original name, instruction and shortcut back. Transforms you created stay as they are.`,
    ...withheld,
  ].join(" ");
}

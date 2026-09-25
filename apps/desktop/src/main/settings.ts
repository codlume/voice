import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import type { Settings, SettingsPatch } from "../shared/api.ts";

export const DEFAULT_SETTINGS: Settings = {
  hotkey: "fn",
  cleanup: { enabled: true, styling: "semi-casual", structure: "prose", context: "general" },
};

const HOTKEYS = ["fn", "rightOption", "rightCommand"] as const;
const STYLINGS = ["casual", "semi-casual", "semi-formal", "formal"] as const;
const STRUCTURES = ["prose", "lists"] as const;
const CONTEXTS = ["general", "email"] as const;

const pick = <const T extends readonly string[]>(values: T, v: unknown, fallback: T[number]) =>
  typeof v === "string" && values.includes(v) ? (v as T[number]) : fallback;

const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function parseSettings(raw: unknown): Settings {
  const r = record(raw);
  const c = record(r.cleanup);
  const d = DEFAULT_SETTINGS.cleanup;
  return {
    hotkey: pick(HOTKEYS, r.hotkey, DEFAULT_SETTINGS.hotkey),
    cleanup: {
      enabled: typeof c.enabled === "boolean" ? c.enabled : d.enabled,
      styling: pick(STYLINGS, c.styling, d.styling),
      structure: pick(STRUCTURES, c.structure, d.structure),
      context: pick(CONTEXTS, c.context, d.context),
    },
  };
}

export function applyPatch(settings: Settings, patch: SettingsPatch): Settings {
  return parseSettings({
    hotkey: patch.hotkey ?? settings.hotkey,
    cleanup: { ...settings.cleanup, ...patch.cleanup },
  });
}

export async function loadSettings(file: string): Promise<Settings> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return DEFAULT_SETTINGS;
  }
  try {
    return parseSettings(JSON.parse(text));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(file: string, settings: Settings): Promise<void> {
  await mkdir(NodePath.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`);
  await rename(temp, file);
}

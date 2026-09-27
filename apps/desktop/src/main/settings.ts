import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import type { Settings, SettingsPatch, UpdateChannel } from "../shared/api.ts";

export const DEFAULT_SETTINGS: Settings = {
  hotkey: "fn",
  updateChannel: "stable",
  theme: "system",
  cleanup: { enabled: true, styling: "semi-formal" },
};

const THEMES = ["system", "light", "dark"] as const;
const HOTKEYS = ["fn", "rightOption", "rightCommand"] as const;
const STYLINGS = ["casual", "semi-casual", "semi-formal", "formal"] as const;

const pick = <const T extends readonly string[]>(values: T, v: unknown, fallback: T[number]) =>
  typeof v === "string" && values.includes(v) ? (v as T[number]) : fallback;

const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function parseSettings(raw: unknown, defaultChannel: UpdateChannel = "stable"): Settings {
  const r = record(raw);
  const c = record(r.cleanup);
  const d = DEFAULT_SETTINGS.cleanup;
  return {
    hotkey: pick(HOTKEYS, r.hotkey, DEFAULT_SETTINGS.hotkey),
    updateChannel: pick(["stable", "nightly"], r.updateChannel, defaultChannel),
    theme: pick(THEMES, r.theme, DEFAULT_SETTINGS.theme),
    cleanup: {
      enabled: typeof c.enabled === "boolean" ? c.enabled : d.enabled,
      styling: pick(STYLINGS, c.styling, d.styling),
    },
  };
}

export function applyPatch(settings: Settings, patch: SettingsPatch): Settings {
  return parseSettings({
    hotkey: patch.hotkey ?? settings.hotkey,
    updateChannel: patch.updateChannel ?? settings.updateChannel,
    theme: patch.theme ?? settings.theme,
    cleanup: { ...settings.cleanup, ...patch.cleanup },
  });
}

export async function loadSettings(
  file: string,
  defaultChannel: UpdateChannel = "stable",
): Promise<Settings> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return parseSettings(null, defaultChannel);
  }
  try {
    return parseSettings(JSON.parse(text), defaultChannel);
  } catch {
    return parseSettings(null, defaultChannel);
  }
}

export async function saveSettings(file: string, settings: Settings): Promise<void> {
  await mkdir(NodePath.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`);
  await rename(temp, file);
}

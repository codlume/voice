import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { MicrophoneSchema } from "../shared/microphone.ts";

import type { Settings, SettingsPatch, UpdateChannel } from "../shared/api.ts";

import { hotkeys } from "../shared/api.ts";
import { parseDictationLanguage } from "../shared/dictation-language.ts";

export const DEFAULT_SETTINGS: Settings = {
  microphone: null,
  hotkey: "fn",
  muteWhileDictating: false,
  dictationLanguage: "en",
  updateChannel: "stable",
  theme: "system",
  cleanup: { enabled: true, styling: "semi-formal" },
  diagnostics: "unanswered",
};

const THEMES = ["system", "light", "dark"] as const;
const STYLINGS = ["casual", "semi-casual", "semi-formal", "formal"] as const;
const CONSENTS = ["unanswered", "on", "off"] as const;

const pick = <const T extends readonly string[]>(values: T, v: unknown, fallback: T[number]) =>
  typeof v === "string" && values.includes(v) ? (v as T[number]) : fallback;

const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function parseSettings(raw: unknown, defaultChannel: UpdateChannel = "stable"): Settings {
  const r = record(raw);
  const c = record(r.cleanup);
  const d = DEFAULT_SETTINGS.cleanup;
  return {
    microphone: Option.getOrNull(Schema.decodeUnknownOption(MicrophoneSchema)(r.microphone)),
    hotkey: pick(hotkeys, r.hotkey, DEFAULT_SETTINGS.hotkey),
    updateChannel: pick(["stable", "nightly"], r.updateChannel, defaultChannel),
    dictationLanguage: parseDictationLanguage(r.dictationLanguage),
    theme: pick(THEMES, r.theme, DEFAULT_SETTINGS.theme),
    muteWhileDictating: typeof r.muteWhileDictating === "boolean" ? r.muteWhileDictating : false,
    cleanup: {
      enabled: typeof c.enabled === "boolean" ? c.enabled : d.enabled,
      styling: pick(STYLINGS, c.styling, d.styling),
    },
    diagnostics: pick(CONSENTS, r.diagnostics, DEFAULT_SETTINGS.diagnostics),
  };
}

export function applyPatch(settings: Settings, patch: SettingsPatch): Settings {
  return parseSettings({
    microphone: patch.microphone === undefined ? settings.microphone : patch.microphone,
    hotkey: patch.hotkey ?? settings.hotkey,
    updateChannel: patch.updateChannel ?? settings.updateChannel,
    dictationLanguage: patch.dictationLanguage ?? settings.dictationLanguage,
    theme: patch.theme ?? settings.theme,
    muteWhileDictating: patch.muteWhileDictating ?? settings.muteWhileDictating,
    cleanup: { ...settings.cleanup, ...patch.cleanup },
    diagnostics: patch.diagnostics ?? settings.diagnostics,
  });
}

// Synchronous because launch reads the diagnostics choice before Electron's ready event.
export function loadSettings(file: string, defaultChannel: UpdateChannel = "stable"): Settings {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
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

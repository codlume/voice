import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { MicrophoneSchema } from "../shared/microphone.ts";

import type { Settings, SettingsPatch, UpdateChannel } from "../shared/api.ts";

import { hotkeys } from "../shared/api.ts";
import { parseDictationLanguage } from "../shared/dictation-language.ts";
import { parseZoomLevel } from "../shared/zoom.ts";

export const DEFAULT_SETTINGS: Settings = {
  microphone: null,
  hotkey: "fn",
  muteWhileDictating: false,
  copyToClipboard: false,
  showInDock: true,
  alwaysShowPill: true,
  dictationLanguage: "en",
  updateChannel: "stable",
  theme: "system",
  cleanup: { enabled: true, styling: "semi-formal" },
  diagnostics: "off",
  zoomLevel: 0,
};

const THEMES = ["system", "light", "dark"] as const;
const STYLINGS = ["casual", "semi-casual", "semi-formal", "formal"] as const;
const CONSENTS = ["on", "off"] as const;

const pick = <const T extends readonly string[]>(values: T, v: unknown, fallback: T[number]) =>
  typeof v === "string" && values.includes(v) ? (v as T[number]) : fallback;

const flag = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

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
    muteWhileDictating: flag(r.muteWhileDictating, DEFAULT_SETTINGS.muteWhileDictating),
    copyToClipboard: flag(r.copyToClipboard, DEFAULT_SETTINGS.copyToClipboard),
    showInDock: flag(r.showInDock, DEFAULT_SETTINGS.showInDock),
    alwaysShowPill: flag(r.alwaysShowPill, DEFAULT_SETTINGS.alwaysShowPill),
    cleanup: {
      enabled: flag(c.enabled, d.enabled),
      styling: pick(STYLINGS, c.styling, d.styling),
    },
    diagnostics: pick(CONSENTS, r.diagnostics, DEFAULT_SETTINGS.diagnostics),
    zoomLevel: parseZoomLevel(r.zoomLevel),
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
    copyToClipboard: patch.copyToClipboard ?? settings.copyToClipboard,
    showInDock: patch.showInDock ?? settings.showInDock,
    alwaysShowPill: patch.alwaysShowPill ?? settings.alwaysShowPill,
    cleanup: { ...settings.cleanup, ...patch.cleanup },
    diagnostics: patch.diagnostics ?? settings.diagnostics,
    zoomLevel: patch.zoomLevel ?? settings.zoomLevel,
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

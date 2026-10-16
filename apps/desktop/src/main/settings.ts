import { readFileSync } from "node:fs";

import { WRITING_STYLES, type WritingStyle } from "@voice/cleanup/style";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { MicrophoneSchema } from "../shared/microphone.ts";

import type { Settings, SettingsPatch, UpdateChannel } from "../shared/api.ts";

import { DEFAULT_SETTINGS, hotkeys } from "../shared/api.ts";
import { parseDictionary } from "../shared/dictionary.ts";
import { parseDictationLanguage } from "../shared/dictation-language.ts";
import { parseSnippets } from "../shared/snippets.ts";
import type { Category } from "../shared/app-categories.ts";
import { DEFAULT_STYLES, parseAssignments, type CategoryStyles } from "../shared/style.ts";
import { parseZoomLevel } from "../shared/zoom.ts";
import { writeFileAtomic } from "./atomic-file.ts";

const THEMES = ["system", "light", "dark"] as const;
const CONSENTS = ["on", "off"] as const;
const STYLE_BY_LEGACY_STYLING = new Map<unknown, WritingStyle>([
  ["casual", "veryCasual"],
  ["semi-casual", "casual"],
  ["semi-formal", "formal"],
  ["formal", "formal"],
]);

const pick = <const T extends readonly string[], F extends T[number] | null>(
  values: T,
  v: unknown,
  fallback: F,
): T[number] | F => (typeof v === "string" && values.includes(v) ? (v as T[number]) : fallback);

const flag = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const record = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

function parseStyles(c: Record<string, unknown>): CategoryStyles {
  const { styles } = c;
  const legacyGlobalStyle = pick(
    WRITING_STYLES,
    c.style,
    STYLE_BY_LEGACY_STYLING.get(c.styling) ?? null,
  );
  const style = (category: Category): WritingStyle =>
    isRecord(styles)
      ? pick(WRITING_STYLES, styles[category], DEFAULT_STYLES[category])
      : (legacyGlobalStyle ?? DEFAULT_STYLES[category]);
  return {
    personal: style("personal"),
    work: style("work"),
    email: style("email"),
    other: style("other"),
  };
}

export function parseSettings(raw: unknown, defaultChannel: UpdateChannel = "stable"): Settings {
  const r = record(raw);
  const c = record(r.cleanup);
  const d = DEFAULT_SETTINGS.cleanup;
  const hotkey = pick(hotkeys, r.hotkey, DEFAULT_SETTINGS.hotkey);
  const toggleHotkey = pick(hotkeys, r.toggleHotkey, null);
  return {
    microphone: Option.getOrNull(Schema.decodeUnknownOption(MicrophoneSchema)(r.microphone)),
    hotkey,
    // One key cannot both hold and toggle, so taking it for holding turns toggling off.
    toggleHotkey: toggleHotkey === hotkey ? null : toggleHotkey,
    updateChannel: pick(["stable", "nightly"], r.updateChannel, defaultChannel),
    dictationLanguage: parseDictationLanguage(r.dictationLanguage),
    theme: pick(THEMES, r.theme, DEFAULT_SETTINGS.theme),
    muteWhileDictating: flag(r.muteWhileDictating, DEFAULT_SETTINGS.muteWhileDictating),
    copyToClipboard: flag(r.copyToClipboard, DEFAULT_SETTINGS.copyToClipboard),
    showInDock: flag(r.showInDock, DEFAULT_SETTINGS.showInDock),
    alwaysShowPill: flag(r.alwaysShowPill, DEFAULT_SETTINGS.alwaysShowPill),
    cleanup: {
      enabled: flag(c.enabled, d.enabled),
      styles: parseStyles(c),
      assignments: parseAssignments(c.assignments),
    },
    diagnostics: pick(CONSENTS, r.diagnostics, DEFAULT_SETTINGS.diagnostics),
    snippets: parseSnippets(r.snippets),
    dictionary: parseDictionary(r.dictionary),
    zoomLevel: parseZoomLevel(r.zoomLevel),
  };
}

export function applyPatch(settings: Settings, patch: SettingsPatch): Settings {
  const { snippets, dictionary } = patch;
  const assignments = patch.cleanup?.assignments;
  // Parsing drops invalid items; refuse the save rather than lose text the user just typed.
  if (
    snippets !== undefined &&
    (!Array.isArray(snippets) || parseSnippets(snippets).length !== snippets.length)
  ) {
    throw new Error("Could not save these snippets.");
  }
  if (
    dictionary !== undefined &&
    (!Array.isArray(dictionary) || parseDictionary(dictionary).length !== dictionary.length)
  ) {
    throw new Error("Could not save this dictionary.");
  }
  if (
    assignments !== undefined &&
    (!Array.isArray(assignments) || parseAssignments(assignments).length !== assignments.length)
  ) {
    throw new Error("Could not save these app assignments.");
  }
  return parseSettings({
    microphone: patch.microphone === undefined ? settings.microphone : patch.microphone,
    hotkey: patch.hotkey ?? settings.hotkey,
    toggleHotkey: patch.toggleHotkey === undefined ? settings.toggleHotkey : patch.toggleHotkey,
    updateChannel: patch.updateChannel ?? settings.updateChannel,
    dictationLanguage: patch.dictationLanguage ?? settings.dictationLanguage,
    theme: patch.theme ?? settings.theme,
    muteWhileDictating: patch.muteWhileDictating ?? settings.muteWhileDictating,
    copyToClipboard: patch.copyToClipboard ?? settings.copyToClipboard,
    showInDock: patch.showInDock ?? settings.showInDock,
    alwaysShowPill: patch.alwaysShowPill ?? settings.alwaysShowPill,
    cleanup: {
      enabled: patch.cleanup?.enabled ?? settings.cleanup.enabled,
      styles: { ...settings.cleanup.styles, ...patch.cleanup?.styles },
      assignments: assignments ?? settings.cleanup.assignments,
    },
    diagnostics: patch.diagnostics ?? settings.diagnostics,
    snippets: snippets ?? settings.snippets,
    dictionary: dictionary ?? settings.dictionary,
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
  await writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
}

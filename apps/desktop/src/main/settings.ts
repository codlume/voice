import { readFileSync } from "node:fs";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { MicrophoneSchema } from "../shared/microphone.ts";

import type { Settings, SettingsPatch, UpdateChannel } from "../shared/api.ts";

import { DEFAULT_SETTINGS, hotkeys } from "../shared/api.ts";
import { historyRetentions, type HistoryRetention } from "../shared/history.ts";
import { parseDictionary } from "../shared/dictionary.ts";
import { parseDictationLanguage } from "../shared/dictation-language.ts";
import { parseSnippets } from "../shared/snippets.ts";
import { parseZoomLevel } from "../shared/zoom.ts";
import { writeFileAtomic } from "./atomic-file.ts";
import type { Log } from "./diagnostics-scrub.ts";

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
    historyRetention: pick(
      historyRetentions,
      r.historyRetention,
      DEFAULT_SETTINGS.historyRetention,
    ),
    snippets: parseSnippets(r.snippets),
    dictionary: parseDictionary(r.dictionary),
    zoomLevel: parseZoomLevel(r.zoomLevel),
  };
}

export function applyPatch(settings: Settings, patch: SettingsPatch): Settings {
  const { snippets, dictionary } = patch;
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
    historyRetention: patch.historyRetention ?? settings.historyRetention,
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

/**
 * Writes `next`, then moves the history to its retention when that changed. The history moves
 * only once the settings are on disk, so a failed save prunes and deletes nothing, and a move
 * that fails puts the settings back with one write. Rejects with what the user should read.
 */
export async function commitSettings(options: {
  file: string;
  previous: Settings;
  next: Settings;
  moveHistory: (retention: HistoryRetention) => Promise<void>;
  log: Log;
}): Promise<void> {
  const { file, previous, next, moveHistory, log } = options;
  try {
    await saveSettings(file, next);
  } catch (error) {
    log(`settings: save failed (${String(error)})`);
    throw new Error("Could not save this setting. Try again.", { cause: error });
  }
  if (next.historyRetention === previous.historyRetention) return;
  try {
    await moveHistory(next.historyRetention);
  } catch (error) {
    log(`history: retention change failed (${String(error)})`);
    await saveSettings(file, previous).catch((undo: unknown) =>
      log(`settings: could not put the retention back (${String(undo)})`),
    );
    throw new Error("Could not change where your history is kept. Try again.", { cause: error });
  }
}

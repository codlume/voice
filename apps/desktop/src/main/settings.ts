import { readFileSync } from "node:fs";

import { WRITING_STYLES, type WritingStyle } from "@voice/cleanup/style";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { MicrophoneSchema } from "../shared/microphone.ts";

import type { Settings, SettingsPatch, UpdateChannel } from "../shared/api.ts";

import {
  CONSENTS,
  DEFAULT_SETTINGS,
  hotkeys,
  MAX_PAGE_ANIMATION_MS,
  MIN_PAGE_ANIMATION_MS,
  PAGE_ANIMATION_STEP_MS,
  THEMES,
  UPDATE_CHANNELS,
} from "../shared/api.ts";
import { parseDictionary } from "../shared/dictionary.ts";
import { parseDictationLanguage } from "../shared/dictation-language.ts";
import { parseSnippets } from "../shared/snippets.ts";
import { parseTransformSettings } from "../shared/transforms.ts";
import type { Category } from "../shared/app-categories.ts";
import { DEFAULT_STYLES, parseAssignments, type CategoryStyles } from "../shared/style.ts";
import { SettingsPatchSchema } from "../shared/settings-patch.ts";
import { parseZoomLevel } from "../shared/zoom.ts";
import { writeFileAtomic } from "./atomic-file.ts";

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

const pageAnimationMs = (v: unknown) =>
  typeof v === "number" &&
  v % PAGE_ANIMATION_STEP_MS === 0 &&
  v >= MIN_PAGE_ANIMATION_MS &&
  v <= MAX_PAGE_ANIMATION_MS
    ? v
    : DEFAULT_SETTINGS.pageAnimationMs;

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
    updateChannel: pick(UPDATE_CHANNELS, r.updateChannel, defaultChannel),
    dictationLanguage: parseDictationLanguage(r.dictationLanguage),
    theme: pick(THEMES, r.theme, DEFAULT_SETTINGS.theme),
    pageAnimationMs: pageAnimationMs(r.pageAnimationMs),
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
    transforms: parseTransformSettings(r.transforms),
  };
}

const decodePatch = Schema.decodeUnknownOption(SettingsPatchSchema, { onExcessProperty: "error" });

/** Parses a patch from the renderer, refusing the save rather than dropping what it cannot read. */
export function parseSettingsPatch(raw: unknown): SettingsPatch {
  return Option.getOrThrowWith(decodePatch(raw), () => new Error("Could not save these settings."));
}

export function applyPatch(settings: Settings, { cleanup, ...patch }: SettingsPatch): Settings {
  const next: Settings = {
    ...settings,
    ...patch,
    cleanup: {
      ...settings.cleanup,
      ...cleanup,
      styles: { ...settings.cleanup.styles, ...cleanup?.styles },
    },
  };
  // Parsing again settles what one field cannot check alone, like a toggle key that is also the
  // hold key.
  return parseSettings(next);
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

import { WRITING_STYLES } from "@voice/cleanup/style";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaIssue from "effect/SchemaIssue";

import {
  CONSENTS,
  hotkeys,
  MAX_PAGE_ANIMATION_MS,
  MIN_PAGE_ANIMATION_MS,
  PAGE_ANIMATION_STEP_MS,
  THEMES,
  UPDATE_CHANNELS,
  type Settings,
} from "./api.ts";
import type { Category } from "./app-categories.ts";
import { dictationLanguages } from "./dictation-language.ts";
import { parseDictionary } from "./dictionary.ts";
import { MicrophoneSchema } from "./microphone.ts";
import { parseSnippets } from "./snippets.ts";

// Parsing drops invalid items; refuse the save rather than lose text the user just typed.
const everyItem = <T>(parse: (raw: unknown) => T[]) =>
  Schema.Array(Schema.Unknown).pipe(
    Schema.decodeTo(
      Schema.declare((u): u is readonly T[] => Array.isArray(u)),
      {
        decode: SchemaGetter.transformEffect((items: readonly unknown[]) => {
          const parsed = parse(items);
          return parsed.length === items.length
            ? Effect.succeed(parsed)
            : Effect.fail(new SchemaIssue.InvalidValue());
        }),
        encode: SchemaGetter.passthroughSubtype(),
      },
    ),
  );

const style = Schema.optionalKey(Schema.Literals(WRITING_STYLES));

export const SettingsPatchSchema = Schema.Struct({
  microphone: Schema.optionalKey(Schema.NullOr(MicrophoneSchema)),
  hotkey: Schema.optionalKey(Schema.Literals(hotkeys)),
  toggleHotkey: Schema.optionalKey(Schema.NullOr(Schema.Literals(hotkeys))),
  muteWhileDictating: Schema.optionalKey(Schema.Boolean),
  copyToClipboard: Schema.optionalKey(Schema.Boolean),
  showInDock: Schema.optionalKey(Schema.Boolean),
  alwaysShowPill: Schema.optionalKey(Schema.Boolean),
  dictationLanguage: Schema.optionalKey(
    Schema.Literals(dictationLanguages.map((language) => language.value)),
  ),
  updateChannel: Schema.optionalKey(Schema.Literals(UPDATE_CHANNELS)),
  theme: Schema.optionalKey(Schema.Literals(THEMES)),
  pageAnimationMs: Schema.optionalKey(
    Schema.Number.check(
      Schema.isBetween({ minimum: MIN_PAGE_ANIMATION_MS, maximum: MAX_PAGE_ANIMATION_MS }),
      Schema.isMultipleOf(PAGE_ANIMATION_STEP_MS),
    ),
  ),
  // A patch cannot replace the assignments; they change one edit at a time.
  cleanup: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      styles: Schema.optionalKey(
        Schema.Struct({
          personal: style,
          work: style,
          email: style,
          other: style,
        } satisfies Record<Category, unknown>),
      ),
    }),
  ),
  diagnostics: Schema.optionalKey(Schema.Literals(CONSENTS)),
  snippets: Schema.optionalKey(everyItem(parseSnippets)),
  dictionary: Schema.optionalKey(everyItem(parseDictionary)),
  zoomLevel: Schema.optionalKey(Schema.Finite),
} satisfies Record<keyof Settings, unknown>);

export type SettingsPatch = typeof SettingsPatchSchema.Type;

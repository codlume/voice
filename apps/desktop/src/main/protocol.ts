import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { Hotkey, PermissionKind } from "../shared/api.ts";
import type { DictationLanguage } from "../shared/dictation-language.ts";

// Bump together with the helper's `ready` version whenever a line's shape changes.
export const HELPER_PROTOCOL_VERSION = 3;

export type HelperCommand =
  | { type: "hotkey.configure"; key: Hotkey }
  | { type: "capture.start"; id: string; language: DictationLanguage; muteWhileDictating: boolean }
  | { type: "capture.stop"; id: string }
  | { type: "capture.cancel"; id: string }
  | { type: "insert"; id: string; text: string }
  | { type: "permissions.check" }
  | { type: "permissions.request"; kind: PermissionKind }
  | { type: "asr.prepare"; download: boolean };

const permissionState = Schema.Literal("granted", "denied", "notDetermined");
const insertFailure = Schema.NullOr(
  Schema.Literal("focusChanged", "noFocusedField", "secureInput", "failed"),
).annotations({ decodingFallback: () => Effect.succeed(null) });
const statusMessage = Schema.NullOr(Schema.String).annotations({
  decodingFallback: () => Effect.succeed(null),
});

const HelperEventSchema = Schema.Union(
  Schema.Struct({ type: Schema.Literal("ready"), version: Schema.Finite }),
  Schema.Struct({
    type: Schema.Literal("hotkey"),
    action: Schema.Literal("down", "up", "cancel"),
  }),
  Schema.Struct({
    type: Schema.Literal("capture.started"),
    id: Schema.String,
    startMs: Schema.Finite,
  }),
  Schema.Struct({
    type: Schema.Literal("capture.level"),
    id: Schema.String,
    level: Schema.Finite.pipe(Schema.clamp(0, 1)),
  }),
  Schema.Struct({
    type: Schema.Literal("capture.failed"),
    id: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("capture.cancelled"), id: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("transcript"),
    id: Schema.String,
    text: Schema.String,
    audioMs: Schema.Finite,
    asrMs: Schema.Finite,
  }),
  Schema.Struct({
    type: Schema.Literal("transcript.failed"),
    id: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("insert.result"),
    id: Schema.String,
    method: Schema.Literal("accessibility", "paste", "none"),
    reason: Schema.optionalWith(insertFailure, { default: () => null }),
  }),
  Schema.Struct({
    type: Schema.Literal("permissions"),
    microphone: permissionState,
    accessibility: permissionState,
  }),
  Schema.Struct({
    type: Schema.Literal("asr.status"),
    state: Schema.Literal("missing", "downloading", "loading", "ready", "failed"),
    message: Schema.optionalWith(statusMessage, { default: () => null }),
  }),
  Schema.Struct({
    type: Schema.Literal("log"),
    level: Schema.Literal("info", "error"),
    message: Schema.String,
  }),
);

export type HelperEvent = typeof HelperEventSchema.Type;

const decodeHelperEvent = Schema.decodeUnknownOption(Schema.parseJson(HelperEventSchema));

export function parseHelperEvent(line: string): HelperEvent | null {
  return Option.getOrNull(decodeHelperEvent(line));
}

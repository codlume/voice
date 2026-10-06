import * as Effect from "effect/Effect";
import { clamp } from "effect/Number";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

import { MicrophoneSchema } from "../shared/microphone.ts";

import type { Hotkey, Microphone, PermissionKind } from "../shared/api.ts";
import type { DictationLanguage } from "../shared/dictation-language.ts";

// Bump together with the helper's `ready` version whenever a line's shape changes.
export const HELPER_PROTOCOL_VERSION = 6;

export type HelperCommand =
  | { type: "hotkey.configure"; key: Hotkey }
  | { type: "microphone.configure"; microphone: Microphone | null }
  | {
      type: "capture.start";
      id: string;
      language: DictationLanguage;
      muteWhileDictating: boolean;
      microphone: Microphone | null;
    }
  | { type: "capture.stop"; id: string }
  | { type: "capture.cancel"; id: string }
  | { type: "microphone.test.start"; id: string; microphone: Microphone | null }
  | { type: "microphone.test.stop"; id: string }
  | { type: "insert"; id: string; text: string }
  | { type: "permissions.check" }
  | { type: "permissions.request"; kind: PermissionKind }
  | { type: "asr.prepare"; download: boolean }
  | { type: "asr.remove" };

const permissionState = Schema.Literals(["granted", "denied", "notDetermined"]);
// The default covers a missing key and catchDecoding a malformed value; neither covers both.
const nullOnInvalid = <S extends Schema.Top>(schema: S) =>
  Schema.NullOr(schema).pipe(
    Schema.catchDecoding(() => Effect.succeedSome(null)),
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  );
const insertFailure = nullOnInvalid(
  Schema.Literals(["focusChanged", "noFocusedField", "secureInput", "failed"]),
);
const statusMessage = nullOnInvalid(Schema.String);
const level = Schema.Finite.pipe(
  Schema.decode({
    decode: SchemaGetter.transform(clamp({ minimum: 0, maximum: 1 })),
    encode: SchemaGetter.passthrough(),
  }),
);

const HelperEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("microphones.changed"),
    devices: Schema.Array(MicrophoneSchema),
    defaultUid: Schema.NullOr(MicrophoneSchema.fields.uid),
  }),
  Schema.Struct({ type: Schema.Literal("microphones.unavailable"), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("ready"), version: Schema.Finite }),
  Schema.Struct({
    type: Schema.Literal("hotkey"),
    action: Schema.Literals(["down", "up", "cancel"]),
  }),
  Schema.Struct({
    type: Schema.Literal("capture.started"),
    id: Schema.String,
    startMs: Schema.Finite,
  }),
  Schema.Struct({
    type: Schema.Literal("capture.level"),
    id: Schema.String,
    level,
  }),
  Schema.Struct({
    type: Schema.Literal("capture.failed"),
    id: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("capture.cancelled"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("microphone.test.started"), id: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("microphone.test.level"),
    id: Schema.String,
    level,
  }),
  Schema.Struct({ type: Schema.Literal("microphone.test.ended"), id: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("microphone.test.failed"),
    id: Schema.String,
    message: Schema.String,
  }),
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
    method: Schema.Literals(["accessibility", "paste", "none"]),
    reason: insertFailure,
  }),
  Schema.Struct({
    type: Schema.Literal("permissions"),
    microphone: permissionState,
    accessibility: permissionState,
  }),
  Schema.Struct({
    type: Schema.Literal("asr.status"),
    state: Schema.Literals(["missing", "downloading", "loading", "ready", "failed"]),
    message: statusMessage,
  }),
  Schema.Struct({
    type: Schema.Literal("log"),
    level: Schema.Literals(["info", "error"]),
    message: Schema.String,
  }),
]);

export type HelperEvent = typeof HelperEventSchema.Type;

const decodeHelperEvent = Schema.decodeUnknownOption(Schema.fromJsonString(HelperEventSchema));

export function parseHelperEvent(line: string): HelperEvent | null {
  return Option.getOrNull(decodeHelperEvent(line));
}

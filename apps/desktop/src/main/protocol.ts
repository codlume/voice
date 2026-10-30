import * as Effect from "effect/Effect";
import { clamp } from "effect/Number";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaIssue from "effect/SchemaIssue";

import { parseBundleId, parseHost } from "../shared/app-categories.ts";
import { MicrophoneSchema } from "../shared/microphone.ts";

import type { Hotkey, Microphone, PermissionKind } from "../shared/api.ts";
import type { DictationLanguage } from "../shared/dictation-language.ts";
import type { Target } from "../shared/style.ts";
import type { HelperShortcut } from "../shared/transforms.ts";

// Bump together with the helper's `ready` version whenever a line's shape changes.
export const HELPER_PROTOCOL_VERSION = 15;

export type HelperCommand =
  | {
      type: "hotkey.configure";
      key: Hotkey;
      toggleKey: Hotkey | null;
      transforms: readonly HelperShortcut[];
    }
  | { type: "microphone.configure"; microphone: Microphone | null }
  | {
      type: "capture.start";
      id: string;
      language: DictationLanguage;
      // The fraction of each output's level to keep while capturing, at least 0 and below 1;
      // 0 mutes and null leaves outputs alone.
      outputVolumeScale: number | null;
      microphone: Microphone | null;
      // False when the session cannot use a page host, so the helper never reads one.
      detectHost: boolean;
      // The `uptimeMs` of the hotkey event this command answers, so the helper can measure the
      // round trip. Absent when no hotkey caused it.
      hotkeyUptimeMs?: number | undefined;
    }
  | { type: "capture.stop"; id: string; hotkeyUptimeMs?: number | undefined }
  | { type: "capture.cancel"; id: string }
  | { type: "microphone.test.start"; id: string; microphone: Microphone | null }
  | { type: "microphone.test.stop"; id: string }
  | { type: "insert"; id: string; text: string; html: string | null }
  | { type: "selection.read"; id: string }
  | { type: "transform.end"; id: string }
  | { type: "permissions.check" }
  | { type: "permissions.request"; kind: PermissionKind }
  | { type: "asr.prepare"; download: boolean }
  | { type: "asr.remove" }
  | { type: "test.target"; target: Target | null }
  | { type: "apps.list" }
  | { type: "icons.render"; id: string; paths: string[] };

const permissionState = Schema.Literals(["granted", "denied", "notDetermined"]);
// The default covers a missing key and catchDecoding a malformed value; neither covers both.
const nullOnInvalid = <S extends Schema.Top>(schema: S) =>
  Schema.NullOr(schema).pipe(
    Schema.catchDecoding(() => Effect.succeedSome(null)),
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  );
const insertFailure = nullOnInvalid(
  Schema.Literals(["focusChanged", "noFocusedField", "secureInput", "selectionChanged", "failed"]),
);
const statusMessage = nullOnInvalid(Schema.String);
const parsedBy = <T extends string>(parse: (input: string) => T | null) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.declare((u): u is T => typeof u === "string" && parse(u) === u),
      {
        decode: SchemaGetter.transformEffect((input: string) => {
          const value = parse(input);
          return value === null
            ? Effect.fail(new SchemaIssue.InvalidValue())
            : Effect.succeed(value);
        }),
        encode: SchemaGetter.passthroughSubtype(),
      },
    ),
  );
const TargetSchema = Schema.NullOr(
  Schema.Struct({
    bundleId: parsedBy(parseBundleId),
    host: Schema.NullOr(parsedBy(parseHost)).pipe(
      Schema.catchDecoding(() => Effect.succeedSome(null)),
    ),
  }),
);
export const decodeTarget = Schema.decodeUnknownOption(TargetSchema);
const target = nullOnInvalid(TargetSchema);
const validEntries = <S extends Schema.Top>(entry: S) =>
  Schema.Array(
    Schema.NullOr(entry).pipe(Schema.catchDecoding(() => Effect.succeedSome(null))),
  ).pipe(
    Schema.decodeTo(Schema.Array(Schema.toType(entry)), {
      decode: SchemaGetter.transform((entries) => entries.filter((e) => e !== null)),
      encode: SchemaGetter.transform((entries) => entries),
    }),
  );
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
  // down/up/chord come from the hold key, toggle from a clean tap of the toggle key, cancel from Escape.
  // uptimeMs is the helper's monotonic clock at the key event, echoed back on capture.start/stop.
  Schema.Struct({
    type: Schema.Literal("hotkey"),
    action: Schema.Literals(["down", "up", "chord", "cancel", "toggle"]),
    uptimeMs: nullOnInvalid(Schema.Finite),
  }),
  Schema.Struct({ type: Schema.Literal("transform"), transformId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("selection.result"),
    id: Schema.String,
    outcome: Schema.Literal("selected"),
    text: Schema.String,
    via: Schema.Literals(["accessibility", "copy"]),
  }),
  Schema.Struct({
    type: Schema.Literal("selection.result"),
    id: Schema.String,
    outcome: Schema.Literal("failed"),
    reason: Schema.Literals(["noSelection", "secureInput", "noFocusedField", "keysHeld", "failed"]),
  }),
  Schema.Struct({
    type: Schema.Literal("capture.started"),
    id: Schema.String,
    startMs: Schema.Finite,
    relayMs: nullOnInvalid(Schema.Finite),
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
  Schema.Struct({
    type: Schema.Literal("capture.stopped"),
    id: Schema.String,
    reason: Schema.Literals(["deviceChanged", "maxDuration"]),
  }),
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
    speechMs: nullOnInvalid(Schema.Finite),
    relayMs: nullOnInvalid(Schema.Finite),
    target,
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
    type: Schema.Literal("apps.listed"),
    apps: validEntries(
      Schema.Struct({
        bundleId: Schema.String,
        name: Schema.String,
        path: Schema.String,
        modifiedMs: Schema.Finite,
        browser: Schema.Boolean,
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("icons.rendered"),
    id: Schema.String,
    icons: validEntries(Schema.Struct({ path: Schema.String, png: Schema.String })),
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

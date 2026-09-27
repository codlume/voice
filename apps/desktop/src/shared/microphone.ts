import * as Schema from "effect/Schema";

export const MicrophoneSchema = Schema.Struct({
  uid: Schema.NonEmptyTrimmedString,
  name: Schema.NonEmptyTrimmedString,
});

export type Microphone = typeof MicrophoneSchema.Type;

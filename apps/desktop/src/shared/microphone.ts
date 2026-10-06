import * as Schema from "effect/Schema";

const NonEmptyTrimmedString = Schema.Trimmed.check(Schema.isNonEmpty());

export const MicrophoneSchema = Schema.Struct({
  uid: NonEmptyTrimmedString,
  name: NonEmptyTrimmedString,
});

export type Microphone = typeof MicrophoneSchema.Type;

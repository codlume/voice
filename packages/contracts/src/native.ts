import { Schema } from "effect";
export const NativeReply = Schema.Struct({
  type: Schema.Literals(["ready", "cancelled", "stopped", "rejected"]),
  version: Schema.Literal(1),
  capture: Schema.Literal("unavailable"),
});
export const decodeNativeReply = Schema.decodeUnknownSync(NativeReply, {
  onExcessProperty: "error",
});

import { Schema } from "effect";
import { Settings } from "./desktop";

export const WorkerOptions = Schema.Struct({ filename: Schema.String, migrations: Schema.String });
export const WorkerRequest = Schema.Union([
  Schema.Struct({ id: Schema.Number, type: Schema.Literal("set"), settings: Settings }),
  Schema.Struct({ id: Schema.Number, type: Schema.Literal("close") }),
]);
export type WorkerRequest = typeof WorkerRequest.Type;
export const WorkerEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready"), settings: Settings }),
  Schema.Struct({ type: Schema.Literal("result"), id: Schema.Number, settings: Settings }),
  Schema.Struct({ type: Schema.Literal("closed"), id: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("failed") }),
]);
export const decodeWorkerOptions = Schema.decodeUnknownSync(WorkerOptions, {
  onExcessProperty: "error",
});
export const decodeWorkerRequest = Schema.decodeUnknownSync(WorkerRequest, {
  onExcessProperty: "error",
});
export const decodeWorkerEvent = Schema.decodeUnknownSync(WorkerEvent, {
  onExcessProperty: "error",
});

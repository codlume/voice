// The transform model's utility process. Its own process, not a second engine in the cleanup
// worker, so a crash or a memory kill here cannot stop dictation cleanup.
import type { TransformEngine } from "@voice/cleanup/transform";
import * as Schema from "effect/Schema";

import {
  createEngineProcess,
  serveEngine,
  type ForkEngine,
  type ParentPort,
} from "./engine-process.ts";

const TransformSchema = Schema.Struct({
  type: Schema.Literal("transform"),
  id: Schema.Int,
  instruction: Schema.String,
  text: Schema.String,
  dictation: Schema.Boolean,
  budgetMs: Schema.Finite,
});

const ResultSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), text: Schema.String }),
  Schema.Struct({
    ok: Schema.Literal(false),
    failure: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("tooLong"), maxWords: Schema.Int }),
      Schema.Struct({ kind: Schema.Literal("timedOut") }),
      Schema.Struct({ kind: Schema.Literal("rejected") }),
    ]),
  }),
]);

const decodeTransform = Schema.decodeUnknownOption(TransformSchema);

export function serve(
  port: ParentPort,
  createEngine: (options: { modelPath: string }) => TransformEngine,
) {
  serveEngine(port, {
    name: "transform model",
    create: createEngine,
    decodeWork: decodeTransform,
    work: (engine, { type: _type, id: _id, ...fields }, signal) =>
      engine.transform({ ...fields, signal }),
  });
}

export function createTransformProcess({
  modelPath,
  fork,
  onLost,
}: {
  modelPath: string;
  fork: ForkEngine;
  onLost: (message: string) => void;
}): TransformEngine {
  const engine = createEngineProcess<typeof TransformSchema.Type, typeof ResultSchema.Type>({
    name: "transform model",
    modelPath,
    fork,
    decodeResult: Schema.decodeUnknownOption(ResultSchema),
    onLost,
  });

  return {
    load: engine.load,
    transform: ({ signal, ...fields }) =>
      engine.run((id) => ({ type: "transform", id, ...fields }), signal),
    dispose: engine.dispose,
  };
}

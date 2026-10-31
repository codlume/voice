import type {
  GenerateRequest,
  GenerateResult,
  TransformEngine,
  TransformResult,
} from "@voice/cleanup/transform";
import * as Option from "effect/Option";
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
  dictation: Schema.Union([
    Schema.Literal(false),
    Schema.Struct({ instructionKeepsWords: Schema.Boolean }),
  ]),
  budgetMs: Schema.Finite,
});

const GenerateSchema = Schema.Struct({
  type: Schema.Literal("generate"),
  id: Schema.Int,
  system: Schema.String,
  user: Schema.String,
  maxTokens: Schema.Int,
  temperature: Schema.Finite,
  // node-llama-cpp validates the schema when it builds the grammar.
  jsonSchema: Schema.optionalKey(Schema.Unknown),
  budgetMs: Schema.Finite,
});

const WorkSchema = Schema.Union([TransformSchema, GenerateSchema]);

const TransformResultSchema = Schema.Union([
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

const GenerateResultSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), text: Schema.String, truncated: Schema.Boolean }),
  Schema.Struct({
    ok: Schema.Literal(false),
    failure: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("tooLong") }),
      Schema.Struct({ kind: Schema.Literal("timedOut") }),
    ]),
  }),
]);

const decodeWork = Schema.decodeUnknownOption(WorkSchema);
const decodeTransformResult = Schema.decodeUnknownOption(TransformResultSchema);
const decodeGenerateResult = Schema.decodeUnknownOption(GenerateResultSchema);

const narrow =
  <T>(decode: (result: unknown) => Option.Option<T>) =>
  (result: unknown) => {
    const value = Option.getOrUndefined(decode(result));
    if (value === undefined) throw new Error("The transform model returned a malformed result.");
    return value;
  };

export function serve(
  port: ParentPort,
  createEngine: (options: { modelPath: string }) => TransformEngine,
) {
  serveEngine(port, {
    name: "transform model",
    create: createEngine,
    decodeWork,
    work: (engine, job, signal): Promise<TransformResult | GenerateResult> => {
      if (job.type === "transform") {
        const { type: _type, id: _id, ...fields } = job;
        return engine.transform({ ...fields, signal });
      }
      const { type: _type, id: _id, jsonSchema, ...fields } = job;
      return engine.generate({
        ...fields,
        jsonSchema: jsonSchema as GenerateRequest["jsonSchema"],
        signal,
      });
    },
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
  // Each call decodes the reply as its own kind of result.
  const engine = createEngineProcess<typeof WorkSchema.Type, unknown>({
    name: "transform model",
    modelPath,
    fork,
    decodeResult: Option.some,
    onLost,
  });

  return {
    load: engine.load,
    transform: ({ signal, ...fields }) =>
      engine
        .run((id) => ({ type: "transform", id, ...fields }), signal)
        .then(narrow(decodeTransformResult)),
    generate: ({ signal, jsonSchema, ...fields }) =>
      engine
        .run(
          (id) => ({ type: "generate", id, ...fields, ...(jsonSchema && { jsonSchema }) }),
          signal,
        )
        .then(narrow(decodeGenerateResult)),
    dispose: engine.dispose,
  };
}

// The transform model's utility process. Its own process, not a second engine in the cleanup
// worker, so a crash or a memory kill here cannot stop dictation cleanup.
import type { TransformEngine } from "@voice/cleanup/transform";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  createEngineProcess,
  FailedReplySchema,
  responder,
  type ForkEngine,
  type ParentPort,
} from "./engine-process.ts";

const Id = Schema.Int;

const RequestSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("load"), id: Id, modelPath: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("transform"),
    id: Id,
    instruction: Schema.String,
    text: Schema.String,
    dictation: Schema.Boolean,
    budgetMs: Schema.Finite,
  }),
  Schema.Struct({ type: Schema.Literal("abort"), id: Id }),
  Schema.Struct({ type: Schema.Literal("dispose"), id: Id }),
]);

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

const ReplySchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("loaded"), id: Id }),
  Schema.Struct({ type: Schema.Literal("transformed"), id: Id, result: ResultSchema }),
  FailedReplySchema,
  Schema.Struct({ type: Schema.Literal("disposed"), id: Id }),
]);

type Request = typeof RequestSchema.Type;
type Reply = typeof ReplySchema.Type;

const decodeRequest = Schema.decodeUnknownOption(RequestSchema);
const decodeReply = Schema.decodeUnknownOption(ReplySchema);

export function serve(
  port: ParentPort<Reply>,
  createEngine: (options: { modelPath: string }) => TransformEngine,
) {
  let engine: TransformEngine | undefined;
  const transforms = new Map<number, AbortController>();
  const respond = responder(port);

  port.on("message", ({ data }) => {
    const request = Option.getOrUndefined(decodeRequest(data));
    if (!request) return;
    switch (request.type) {
      case "load":
        respond(request.id, async () => {
          engine ??= createEngine({ modelPath: request.modelPath });
          await engine.load();
          return { type: "loaded", id: request.id };
        });
        return;
      case "transform": {
        const { type: _type, id, ...fields } = request;
        const controller = new AbortController();
        transforms.set(id, controller);
        respond(id, async () => {
          try {
            if (!engine) throw new Error("transform model is not loaded");
            const result = await engine.transform({ ...fields, signal: controller.signal });
            return { type: "transformed", id, result };
          } finally {
            transforms.delete(id);
          }
        });
        return;
      }
      case "abort":
        transforms.get(request.id)?.abort();
        return;
      case "dispose":
        respond(request.id, async () => {
          for (const controller of transforms.values()) controller.abort();
          await engine?.dispose();
          return { type: "disposed", id: request.id };
        });
        return;
    }
  });
}

export type ForkTransformEngine = ForkEngine<Request>;

export function createTransformProcess({
  modelPath,
  fork,
  onLost,
}: {
  modelPath: string;
  fork: ForkTransformEngine;
  onLost: (message: string) => void;
}): TransformEngine {
  const engine = createEngineProcess<Request, Reply>({
    name: "transform model",
    fork,
    decodeReply: (message) => Option.getOrUndefined(decodeReply(message)),
    abort: (id) => ({ type: "abort", id }),
    dispose: (id) => ({ type: "dispose", id }),
    onLost,
  });

  return {
    load: async () => {
      const reply = await engine.call((id) => ({ type: "load", id, modelPath }));
      if (reply.type !== "loaded") throw new Error(`transform engine replied ${reply.type}`);
    },
    transform: async ({ signal, ...fields }) => {
      const reply = await engine.call((id) => ({ type: "transform", id, ...fields }), signal);
      if (reply.type !== "transformed") throw new Error(`transform engine replied ${reply.type}`);
      return reply.result;
    },
    dispose: engine.dispose,
  };
}

import type { S1Mini } from "@voice/cleanup";
import { LAYOUTS, WRITING_STYLES } from "@voice/cleanup/style";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  createEngineProcess,
  FailedReplySchema,
  responder,
  type ForkEngine as ForkEngineOf,
  type ParentPort,
} from "./engine-process.ts";

export { ABORT_GRACE_MS, DISPOSE_GRACE_MS } from "./engine-process.ts";

export type CleanupEngine = Pick<S1Mini, "load" | "clean" | "keepGpuBusy" | "dispose">;

const Id = Schema.Int;

const RequestSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("load"), id: Id, modelPath: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("clean"),
    id: Id,
    raw: Schema.String,
    style: Schema.Struct({
      style: Schema.Literals(WRITING_STYLES),
      layout: Schema.Literals(LAYOUTS),
    }),
    budgetMs: Schema.optionalKey(Schema.Finite),
  }),
  Schema.Struct({ type: Schema.Literal("abort"), id: Id }),
  Schema.Struct({ type: Schema.Literal("keepGpuBusy"), ms: Schema.Finite }),
  Schema.Struct({ type: Schema.Literal("dispose"), id: Id }),
]);

const ReplySchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("loaded"), id: Id }),
  Schema.Struct({
    type: Schema.Literal("cleaned"),
    id: Id,
    result: Schema.Struct({ text: Schema.String, chunks: Schema.Finite, cleaned: Schema.Finite }),
  }),
  FailedReplySchema,
  Schema.Struct({ type: Schema.Literal("disposed"), id: Id }),
]);

type Request = typeof RequestSchema.Type;
type Reply = typeof ReplySchema.Type;

const decodeRequest = Schema.decodeUnknownOption(RequestSchema);
const decodeReply = Schema.decodeUnknownOption(ReplySchema);

export function serve(
  port: ParentPort<Reply>,
  createEngine: (options: { modelPath: string }) => CleanupEngine,
) {
  let engine: CleanupEngine | undefined;
  const cleans = new Map<number, AbortController>();
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
      case "clean": {
        const { type: _type, id, raw, style, ...budget } = request;
        const controller = new AbortController();
        cleans.set(id, controller);
        respond(id, async () => {
          try {
            if (!engine) throw new Error("cleanup model is not loaded");
            const result = await engine.clean(raw, style, { ...budget, signal: controller.signal });
            return { type: "cleaned", id, result };
          } finally {
            cleans.delete(id);
          }
        });
        return;
      }
      case "abort":
        cleans.get(request.id)?.abort();
        return;
      case "keepGpuBusy":
        engine?.keepGpuBusy(request.ms);
        return;
      case "dispose":
        respond(request.id, async () => {
          for (const controller of cleans.values()) controller.abort();
          await engine?.dispose();
          return { type: "disposed", id: request.id };
        });
        return;
    }
  });
}

export type ForkEngine = ForkEngineOf<Request>;

export function createS1MiniProcess({
  modelPath,
  fork,
  onLost,
}: {
  modelPath: string;
  fork: ForkEngine;
  onLost: (message: string) => void;
}): CleanupEngine {
  const engine = createEngineProcess<Request, Reply>({
    name: "cleanup model",
    fork,
    decodeReply: (message) => Option.getOrUndefined(decodeReply(message)),
    abort: (id) => ({ type: "abort", id }),
    dispose: (id) => ({ type: "dispose", id }),
    onLost,
  });

  return {
    load: async () => {
      const reply = await engine.call((id) => ({ type: "load", id, modelPath }));
      if (reply.type !== "loaded") throw new Error(`cleanup engine replied ${reply.type}`);
    },
    keepGpuBusy: (ms) => engine.post({ type: "keepGpuBusy", ms }),
    clean: async (raw, style, { signal, ...budget } = {}) => {
      const reply = await engine.call(
        (id) => ({ type: "clean", id, raw, style, ...budget }),
        signal,
      );
      if (reply.type !== "cleaned") throw new Error(`cleanup engine replied ${reply.type}`);
      return reply.result;
    },
    dispose: engine.dispose,
  };
}

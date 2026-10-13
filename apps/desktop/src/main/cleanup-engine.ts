import type { S1Mini } from "@voice/cleanup";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type CleanupEngine = Pick<S1Mini, "load" | "clean" | "warm" | "dispose">;

export const ABORT_GRACE_MS = 2000;
export const DISPOSE_GRACE_MS = 2000;
const LOST_MESSAGE = "The cleanup model stopped unexpectedly.";

const Id = Schema.Int;

const RequestSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("load"), id: Id, modelPath: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("clean"),
    id: Id,
    raw: Schema.String,
    style: Schema.Struct({
      styling: Schema.Literals(["casual", "semi-casual", "semi-formal", "formal"]),
    }),
    budgetMs: Schema.optionalKey(Schema.Finite),
  }),
  Schema.Struct({ type: Schema.Literal("abort"), id: Id }),
  Schema.Struct({ type: Schema.Literal("warm"), ms: Schema.Finite }),
  Schema.Struct({ type: Schema.Literal("dispose"), id: Id }),
]);

const ReplySchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("loaded"), id: Id }),
  Schema.Struct({
    type: Schema.Literal("cleaned"),
    id: Id,
    result: Schema.Struct({ text: Schema.String, chunks: Schema.Finite, cleaned: Schema.Finite }),
  }),
  Schema.Struct({
    type: Schema.Literal("failed"),
    id: Id,
    name: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("disposed"), id: Id }),
]);

type Request = typeof RequestSchema.Type;
type Reply = typeof ReplySchema.Type;

const decodeRequest = Schema.decodeUnknownOption(RequestSchema);
const decodeReply = Schema.decodeUnknownOption(ReplySchema);

// Electron's process.parentPort, which wraps each message as { data }.
export type ParentPort = {
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: Reply): void;
};

export function serve(
  port: ParentPort,
  createEngine: (options: { modelPath: string }) => CleanupEngine,
) {
  let engine: CleanupEngine | undefined;
  const cleans = new Map<number, AbortController>();

  function respond(id: number, work: () => Promise<Reply>) {
    void Promise.resolve()
      .then(work)
      .catch((error: unknown): Reply => {
        const { name, message } =
          error instanceof Error ? error : { name: "Error", message: String(error) };
        return { type: "failed", id, name, message };
      })
      .then((reply) => port.postMessage(reply));
  }

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
      case "warm":
        engine?.warm(request.ms);
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

// The utility process seen from main. Electron delivers its messages unwrapped.
export type EngineProcess = { postMessage(message: Request): void; kill(): void };
export type ForkEngine = (events: {
  message(message: unknown): void;
  exit(): void;
}) => EngineProcess;

type Call = { resolve(reply: Reply): void; reject(error: unknown): void; grace?: NodeJS.Timeout };

export function createS1MiniProcess({
  modelPath,
  fork,
  onLost,
}: {
  modelPath: string;
  fork: ForkEngine;
  onLost: (message: string) => void;
}): CleanupEngine {
  const calls = new Map<number, Call>();
  let nextId = 0;
  let lost: Error | undefined;
  let disposal: Promise<void> | undefined;

  function stopped() {
    if (lost) return;
    lost = new Error(LOST_MESSAGE);
    for (const call of calls.values()) {
      clearTimeout(call.grace);
      call.reject(lost);
    }
    calls.clear();
    if (!disposal) onLost(LOST_MESSAGE);
  }

  function kill() {
    stopped();
    port.kill();
  }

  function post(request: Request) {
    try {
      port.postMessage(request);
    } catch {
      kill();
    }
  }

  const port = fork({
    message(message) {
      const reply = Option.getOrUndefined(decodeReply(message));
      const call = reply && calls.get(reply.id);
      if (!reply || !call) return;
      calls.delete(reply.id);
      clearTimeout(call.grace);
      if (reply.type === "failed") {
        call.reject(Object.assign(new Error(reply.message), { name: reply.name }));
      } else {
        call.resolve(reply);
      }
    },
    exit: stopped,
  });

  function send(request: Extract<Request, { id: number }>): Promise<Reply> {
    if (lost) return Promise.reject(lost);
    if (disposal && request.type !== "dispose") {
      return Promise.reject(new Error("cleanup model is disposing"));
    }
    return new Promise((resolve, reject) => {
      calls.set(request.id, { resolve, reject });
      post(request);
    });
  }

  return {
    load: async () => {
      const reply = await send({ type: "load", id: nextId++, modelPath });
      if (reply.type !== "loaded") throw new Error(`cleanup engine replied ${reply.type}`);
    },
    warm: (ms) => {
      if (!lost && !disposal) post({ type: "warm", ms });
    },
    clean: async (raw, style, { signal, ...budget } = {}) => {
      signal?.throwIfAborted();
      const id = nextId++;
      const reply = send({ type: "clean", id, raw, style, ...budget });
      const withdraw = () => {
        const call = calls.get(id);
        if (!call) return;
        call.grace = setTimeout(kill, ABORT_GRACE_MS);
        call.reject(signal?.reason);
        post({ type: "abort", id });
      };
      signal?.addEventListener("abort", withdraw, { once: true });
      if (signal?.aborted) withdraw();
      try {
        const result = await reply;
        if (result.type !== "cleaned") throw new Error(`cleanup engine replied ${result.type}`);
        return result.result;
      } finally {
        signal?.removeEventListener("abort", withdraw);
      }
    },
    dispose: () =>
      (disposal ??= Promise.resolve().then(async () => {
        let timer: NodeJS.Timeout | undefined;
        const grace = new Promise((resolve) => (timer = setTimeout(resolve, DISPOSE_GRACE_MS)));
        await Promise.race([send({ type: "dispose", id: nextId++ }).catch(() => undefined), grace]);
        clearTimeout(timer);
        kill();
      })),
  };
}

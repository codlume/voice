// The parts of a model engine's utility process that do not depend on the model: id-matched
// calls, process loss, the abort grace and a bounded dispose. Each engine adds its own messages.
import * as Schema from "effect/Schema";

export const ABORT_GRACE_MS = 2000;
export const DISPOSE_GRACE_MS = 2000;

export const FailedReplySchema = Schema.Struct({
  type: Schema.Literal("failed"),
  id: Schema.Int,
  name: Schema.String,
  message: Schema.String,
});
type FailedReply = typeof FailedReplySchema.Type;
const isFailed = Schema.is(FailedReplySchema);

// Electron's process.parentPort, which wraps each message as { data }.
export type ParentPort<Reply> = {
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: Reply | FailedReply): void;
};

// Worker side: posts the reply work produces, or a failed reply with the error's name and message.
export function responder<Reply>(port: ParentPort<Reply>) {
  return (id: number, work: () => Promise<Reply>): void => {
    void Promise.resolve()
      .then(work)
      .catch((error: unknown): FailedReply => {
        const { name, message } =
          error instanceof Error ? error : { name: "Error", message: String(error) };
        return { type: "failed", id, name, message };
      })
      .then((reply) => port.postMessage(reply));
  };
}

// The utility process seen from main. Electron delivers its messages unwrapped.
export type ForkEngine<Request> = (events: { message(message: unknown): void; exit(): void }) => {
  postMessage(message: Request): void;
  kill(): void;
};

export type EngineProcess<Request, Reply> = {
  // Settles with the reply carrying the request's id; a failed reply rejects with its error.
  // Aborting rejects at once with the reason and asks the child to stop. A child that has not
  // answered within ABORT_GRACE_MS is killed and reported lost.
  call(request: (id: number) => Request, signal?: AbortSignal): Promise<Reply>;
  // A message without a reply. Dropped once the process is lost or disposing.
  post(request: Request): void;
  // Asks the child to free the engine, then kills it after DISPOSE_GRACE_MS at most.
  dispose(): Promise<void>;
};

type Call<Reply> = {
  resolve(reply: Reply): void;
  reject(error: unknown): void;
  grace?: NodeJS.Timeout;
};

export function createEngineProcess<Request, Reply extends { type: string; id: number }>({
  name,
  fork,
  decodeReply,
  abort,
  dispose,
  onLost,
}: {
  // Lowercase, as in "cleanup model".
  name: string;
  fork: ForkEngine<Request>;
  decodeReply: (message: unknown) => Reply | undefined;
  abort: (id: number) => Request;
  dispose: (id: number) => Request;
  onLost: (message: string) => void;
}): EngineProcess<Request, Reply> {
  const lostMessage = `The ${name} stopped unexpectedly.`;
  const calls = new Map<number, Call<Reply>>();
  let nextId = 0;
  let lost: Error | undefined;
  let disposal: Promise<void> | undefined;

  function stopped() {
    if (lost) return;
    lost = new Error(lostMessage);
    for (const call of calls.values()) {
      clearTimeout(call.grace);
      call.reject(lost);
    }
    calls.clear();
    if (!disposal) onLost(lostMessage);
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
      const reply = decodeReply(message);
      const call = reply && calls.get(reply.id);
      if (!reply || !call) return;
      calls.delete(reply.id);
      clearTimeout(call.grace);
      if (isFailed(reply)) {
        call.reject(Object.assign(new Error(reply.message), { name: reply.name }));
      } else {
        call.resolve(reply);
      }
    },
    exit: stopped,
  });

  function send(id: number, request: Request): Promise<Reply> {
    if (lost) return Promise.reject(lost);
    return new Promise((resolve, reject) => {
      calls.set(id, { resolve, reject });
      post(request);
    });
  }

  return {
    call: async (build, signal) => {
      signal?.throwIfAborted();
      if (disposal && !lost) throw new Error(`${name} is disposing`);
      const id = nextId++;
      const reply = send(id, build(id));
      const withdraw = () => {
        const call = calls.get(id);
        if (!call) return;
        call.grace = setTimeout(kill, ABORT_GRACE_MS);
        call.reject(signal?.reason);
        post(abort(id));
      };
      signal?.addEventListener("abort", withdraw, { once: true });
      if (signal?.aborted) withdraw();
      try {
        return await reply;
      } finally {
        signal?.removeEventListener("abort", withdraw);
      }
    },
    post: (request) => {
      if (!lost && !disposal) post(request);
    },
    dispose: () =>
      (disposal ??= Promise.resolve().then(async () => {
        let timer: NodeJS.Timeout | undefined;
        const grace = new Promise((resolve) => (timer = setTimeout(resolve, DISPOSE_GRACE_MS)));
        const id = nextId++;
        await Promise.race([send(id, dispose(id)).catch(() => undefined), grace]);
        clearTimeout(timer);
        kill();
      })),
  };
}

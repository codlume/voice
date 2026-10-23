import * as NodePath from "node:path";
import { createInterface } from "node:readline";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const ABORT_GRACE_MS = 2000;
export const DISPOSE_GRACE_MS = 2000;

const Id = Schema.Int;

const LifecycleSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("load"), id: Id, modelPath: Schema.String }),
  Schema.Struct({ type: Schema.Literal("abort"), id: Id }),
  Schema.Struct({ type: Schema.Literal("dispose"), id: Id }),
]);
type Lifecycle = typeof LifecycleSchema.Type;
const decodeLifecycle = Schema.decodeUnknownOption(LifecycleSchema);

const ReplySchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("done"),
    id: Id,
    result: Schema.optionalKey(Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal("failed"),
    id: Id,
    name: Schema.String,
    message: Schema.String,
  }),
]);
type Reply = typeof ReplySchema.Type;
const decodeReply = Schema.decodeUnknownOption(ReplySchema);

// Electron's process.parentPort, which wraps each message as { data }.
export type ParentPort = {
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: Reply): void;
};

type Loadable = { load(): Promise<void>; dispose(): Promise<void> };

export function serveEngine<E extends Loadable, Work extends { id: number }, Result>(
  port: ParentPort,
  {
    name,
    create,
    decodeWork,
    work,
    notify,
  }: {
    name: string;
    create: (options: { modelPath: string }) => E;
    decodeWork: (data: unknown) => Option.Option<Work>;
    work: (engine: E, request: Work, signal: AbortSignal) => Promise<Result>;
    notify?: (engine: E | undefined, data: unknown) => void;
  },
): void {
  let engine: E | undefined;
  const running = new Map<number, AbortController>();

  function respond(id: number, task: () => Promise<unknown>) {
    void Promise.resolve()
      .then(task)
      .then(
        (result): Reply => ({ type: "done", id, result }),
        (error: unknown): Reply => {
          const failure =
            error instanceof Error ? error : { name: "Error", message: String(error) };
          return { type: "failed", id, name: failure.name, message: failure.message };
        },
      )
      .then((reply) => port.postMessage(reply));
  }

  function lifecycle(request: Lifecycle) {
    switch (request.type) {
      case "load":
        respond(request.id, async () => {
          engine ??= create({ modelPath: request.modelPath });
          await engine.load();
        });
        return;
      case "abort":
        running.get(request.id)?.abort();
        return;
      case "dispose":
        respond(request.id, async () => {
          for (const controller of running.values()) controller.abort();
          await engine?.dispose();
        });
        return;
    }
  }

  function start(job: Work) {
    const controller = new AbortController();
    running.set(job.id, controller);
    respond(job.id, async () => {
      try {
        if (!engine) throw new Error(`${name} is not loaded`);
        return await work(engine, job, controller.signal);
      } finally {
        running.delete(job.id);
      }
    });
  }

  port.on("message", ({ data }) => {
    const request = Option.getOrUndefined(decodeLifecycle(data));
    const job = request ? undefined : Option.getOrUndefined(decodeWork(data));
    if (request) lifecycle(request);
    else if (job) start(job);
    else notify?.(engine, data);
  });
}

// The utility process seen from main. Electron delivers its messages unwrapped.
export type ForkEngine = (events: { message(message: unknown): void; exit(): void }) => {
  postMessage(message: unknown): void;
  kill(): void;
};

export function forkUtility(
  utilityProcess: typeof import("electron").utilityProcess,
  {
    entry,
    serviceName,
    tag,
    log,
  }: { entry: string; serviceName: string; tag: string; log: (message: string) => void },
): ForkEngine {
  return (events) => {
    const child = utilityProcess.fork(NodePath.join(__dirname, entry), [], {
      serviceName,
      stdio: "pipe",
      execArgv: [],
    });
    child.on("message", events.message).on("exit", (code) => {
      log(`${tag}: exited (${code})`);
      events.exit();
    });
    for (const output of [child.stdout, child.stderr]) {
      if (output) createInterface({ input: output }).on("line", (line) => log(`${tag}: ${line}`));
    }
    return child;
  };
}

export type EngineProcess<Work, Result, Notice> = {
  load(): Promise<void>;
  // Settles with the work's result; a failed reply rejects with the engine's error. Aborting
  // rejects at once with the reason and asks the child to stop. A child that has not answered
  // within ABORT_GRACE_MS is killed and reported lost.
  run(request: (id: number) => Work, signal?: AbortSignal): Promise<Result>;
  post(notice: Notice): void;
  dispose(): Promise<void>;
};

type Call = {
  settle(result: unknown): void;
  reject(error: unknown): void;
  grace?: NodeJS.Timeout;
};

const anyResult = () => Option.some(undefined);

export function createEngineProcess<Work, Result, Notice = never>({
  name,
  modelPath,
  fork,
  decodeResult,
  onLost,
}: {
  name: string;
  modelPath: string;
  fork: ForkEngine;
  decodeResult: (result: unknown) => Option.Option<Result>;
  onLost: (message: string) => void;
}): EngineProcess<Work, Result, Notice> {
  const lostMessage = `The ${name} stopped unexpectedly.`;
  const calls = new Map<number, Call>();
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

  function post(message: Lifecycle | Work | Notice) {
    try {
      port.postMessage(message);
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
        call.settle(reply.result);
      }
    },
    exit: stopped,
  });

  function send<T>(
    id: number,
    message: Lifecycle | Work,
    accept: (result: unknown) => Option.Option<T>,
  ): Promise<T> {
    if (lost) return Promise.reject(lost);
    return new Promise((resolve, reject) => {
      const settle = (result: unknown) => {
        const value = accept(result);
        if (Option.isSome(value)) resolve(value.value);
        else reject(new Error(`The ${name} returned a malformed result.`));
      };
      calls.set(id, { settle, reject });
      post(message);
    });
  }

  async function request<T>(
    build: (id: number) => Lifecycle | Work,
    accept: (result: unknown) => Option.Option<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (disposal && !lost) throw new Error(`${name} is disposing`);
    const id = nextId++;
    const reply = send(id, build(id), accept);
    const withdraw = () => {
      const pending = calls.get(id);
      if (!pending) return;
      pending.grace = setTimeout(kill, ABORT_GRACE_MS);
      pending.reject(signal?.reason);
      post({ type: "abort", id });
    };
    signal?.addEventListener("abort", withdraw, { once: true });
    if (signal?.aborted) withdraw();
    try {
      return await reply;
    } finally {
      signal?.removeEventListener("abort", withdraw);
    }
  }

  return {
    load: () => request((id) => ({ type: "load", id, modelPath }), anyResult),
    run: (build, signal) => request(build, decodeResult, signal),
    post: (notice) => {
      if (!lost && !disposal) post(notice);
    },
    dispose: () =>
      (disposal ??= Promise.resolve().then(async () => {
        let timer: NodeJS.Timeout | undefined;
        const grace = new Promise((resolve) => (timer = setTimeout(resolve, DISPOSE_GRACE_MS)));
        const id = nextId++;
        await Promise.race([
          send(id, { type: "dispose", id }, anyResult).catch(() => undefined),
          grace,
        ]);
        clearTimeout(timer);
        kill();
      })),
  };
}

import { MessageChannel, type MessagePort } from "node:worker_threads";

import * as Schema from "effect/Schema";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import {
  ABORT_GRACE_MS,
  createEngineProcess,
  DISPOSE_GRACE_MS,
  serveEngine,
  type ForkEngine,
} from "./engine-process.ts";

const modelPath = "/models/engine.gguf";

const EchoSchema = Schema.Struct({
  type: Schema.Literal("echo"),
  id: Schema.Int,
  text: Schema.String,
});
type Echo = typeof EchoSchema.Type;
const decodeEcho = Schema.decodeUnknownOption(EchoSchema);

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

type Job = {
  text: string;
  finish(result: string): void;
  fail(error: Error): void;
  aborted: Promise<void>;
};

// A wedged engine ignores abort and never finishes disposing.
function fakeEngine({ wedged = false } = {}) {
  const calls = { modelPaths: [] as string[], loads: 0, disposes: 0, jobs: [] as Job[] };
  const jobStarted = deferred<Job>();
  const disposeStarted = deferred();
  const create = ({ modelPath: path }: { modelPath: string }) => {
    calls.modelPaths.push(path);
    return {
      async load() {
        calls.loads += 1;
      },
      echo: (text: string, signal: AbortSignal) =>
        new Promise<string>((resolve, reject) => {
          const aborted = deferred();
          signal.addEventListener("abort", () => {
            aborted.resolve();
            if (!wedged) reject(signal.reason);
          });
          calls.jobs.push({ text, finish: resolve, fail: reject, aborted: aborted.promise });
          jobStarted.resolve(calls.jobs.at(-1)!);
        }),
      async dispose() {
        calls.disposes += 1;
        disposeStarted.resolve();
        if (wedged) await new Promise(() => {});
      },
    };
  };
  return { calls, create, jobStarted: jobStarted.promise, disposeStarted: disposeStarted.promise };
}

const engineProcess = (fork: ForkEngine, onLost: (message: string) => void) =>
  createEngineProcess<Echo, string>({
    name: "test model",
    modelPath,
    fork,
    decodeResult: Schema.decodeUnknownOption(Schema.String),
    onLost,
  });

const echo = (
  proxy: ReturnType<typeof engineProcess>,
  text: string,
  signal?: AbortSignal,
): Promise<string> => proxy.run((id) => ({ type: "echo", id, text }), signal);

const ports: MessagePort[] = [];
afterEach(() => {
  for (const port of ports.splice(0)) port.close();
  vi.useRealTimers();
});

function connect(engine: Pick<ReturnType<typeof fakeEngine>, "create"> = fakeEngine()) {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  serveEngine(
    {
      on: (_event, listener) => port2.on("message", (data: unknown) => listener({ data })),
      postMessage: (message) => port2.postMessage(message),
    },
    {
      name: "test model",
      create: engine.create,
      decodeWork: decodeEcho,
      work: (instance, { text }, signal) => instance.echo(text, signal),
    },
  );
  const lost: string[] = [];
  const lostSignal = deferred<string>();
  const exited = deferred();
  port1.on("close", () => exited.resolve());
  let kills = 0;
  const proxy = engineProcess(
    (events) => {
      port1.on("message", events.message);
      port1.on("close", events.exit);
      return {
        postMessage: (message) => port1.postMessage(message),
        kill: () => {
          kills += 1;
          port1.close();
        },
      };
    },
    (message) => {
      lost.push(message);
      lostSignal.resolve(message);
    },
  );
  return {
    proxy,
    lost,
    lostSignal: lostSignal.promise,
    exited: exited.promise,
    kills: () => kills,
    crash: () => port2.close(),
  };
}

describe("engine process", () => {
  test("an engine error comes back with its name and message", async () => {
    const engine = fakeEngine();
    const { proxy } = connect(engine);
    await proxy.load();

    const running = echo(proxy, "hello");
    (await engine.jobStarted).fail(
      Object.assign(new Error("context full"), { name: "LlamaError" }),
    );

    const error = await running.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "LlamaError", message: "context full" });
    expect(engine.calls.modelPaths).toEqual([modelPath]);
  });

  test("work before a load fails with the engine not loaded", async () => {
    const { proxy } = connect();

    await expect(echo(proxy, "hello")).rejects.toThrow("test model is not loaded");
  });

  test("abort rejects at once with the reason and withdraws the work in the child", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const engine = fakeEngine();
    const { proxy, kills, lost } = connect(engine);
    await proxy.load();
    const controller = new AbortController();
    const running = echo(proxy, "hello", controller.signal);
    const job = await engine.jobStarted;

    const reason = new Error("session cancelled");
    controller.abort(reason);

    await expect(running).rejects.toBe(reason);
    await job.aborted;
    await proxy.load();
    vi.advanceTimersByTime(ABORT_GRACE_MS);
    expect(kills()).toBe(0);
    expect(lost).toEqual([]);
  });

  test("an already aborted signal rejects without reaching the engine", async () => {
    const engine = fakeEngine();
    const { proxy } = connect(engine);
    await proxy.load();
    const reason = new Error("gone");

    await expect(echo(proxy, "hello", AbortSignal.abort(reason))).rejects.toBe(reason);
    await proxy.load();
    expect(engine.calls.jobs).toEqual([]);
  });

  test("a child that ignores abort is killed after the grace and reported lost", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const engine = fakeEngine({ wedged: true });
    const { proxy, kills, lostSignal } = connect(engine);
    await proxy.load();
    const controller = new AbortController();
    const running = echo(proxy, "hello", controller.signal);
    const job = await engine.jobStarted;

    controller.abort(new Error("cancelled"));
    await expect(running).rejects.toThrow("cancelled");
    await job.aborted;
    vi.advanceTimersByTime(ABORT_GRACE_MS - 1);
    expect(kills()).toBe(0);
    vi.advanceTimersByTime(1);

    expect(kills()).toBe(1);
    await expect(lostSignal).resolves.toBe("The test model stopped unexpectedly.");
  });

  test("a child exit rejects every pending call, reports lost, and refuses later calls", async () => {
    const engine = fakeEngine();
    const { proxy, crash, lostSignal, lost } = connect(engine);
    await proxy.load();
    const first = echo(proxy, "one");
    await engine.jobStarted;
    const second = echo(proxy, "two");

    crash();

    const message = await lostSignal;
    await expect(first).rejects.toThrow(message);
    await expect(second).rejects.toThrow(message);
    await expect(echo(proxy, "three")).rejects.toThrow(message);
    await expect(proxy.load()).rejects.toThrow(message);
    expect(lost).toEqual([message]);
  });

  test("dispose frees the engine, then ends the child without reporting it lost", async () => {
    const engine = fakeEngine();
    const { proxy, kills, lost, exited } = connect(engine);
    await proxy.load();

    await proxy.dispose();
    await exited;

    expect(engine.calls.disposes).toBe(1);
    expect(kills()).toBe(1);
    expect(lost).toEqual([]);
  });

  test("dispose kills a child that does not free the engine within the grace", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const engine = fakeEngine({ wedged: true });
    const { proxy, kills, lost, exited } = connect(engine);
    await proxy.load();

    const disposing = proxy.dispose();
    await engine.disposeStarted;
    expect(kills()).toBe(0);
    vi.advanceTimersByTime(DISPOSE_GRACE_MS);

    await disposing;
    await exited;
    expect(kills()).toBe(1);
    expect(lost).toEqual([]);
  });

  test("dispose aborts the work, refuses new calls, and is idempotent", async () => {
    const engine = fakeEngine();
    const { proxy, lost } = connect(engine);
    await proxy.load();
    const running = echo(proxy, "hello");
    const rejected = expect(running).rejects.toBeInstanceOf(Error);
    const job = await engine.jobStarted;

    const disposing = proxy.dispose();
    expect(proxy.dispose()).toBe(disposing);
    await expect(proxy.load()).rejects.toThrow("disposing");
    await expect(echo(proxy, "later")).rejects.toThrow("disposing");
    await job.aborted;
    await rejected;
    await disposing;
    expect(engine.calls.disposes).toBe(1);
    expect(lost).toEqual([]);
  });

  test("abort before the work arrives still reaches the child", async () => {
    const engine = fakeEngine();
    const { proxy, lost } = connect(engine);
    await proxy.load();
    const controller = new AbortController();
    const running = echo(proxy, "hello", controller.signal);
    controller.abort(new Error("withdrawn"));

    await expect(running).rejects.toThrow("withdrawn");
    const job = await engine.jobStarted;
    await job.aborted;
    await proxy.load();
    expect(lost).toEqual([]);
  });

  test("a synchronous engine factory failure returns an error", async () => {
    const { proxy } = connect({
      create: () => {
        throw new Error("cannot allocate");
      },
    });
    await expect(proxy.load()).rejects.toThrow("cannot allocate");
    await proxy.dispose();
  });

  test("a broken transport rejects all calls without waiting for an exit event", async () => {
    const lost = vi.fn();
    const kill = vi.fn();
    let broken = false;
    const proxy = engineProcess(
      () => ({
        kill,
        postMessage: () => {
          if (broken) throw new Error("port closed");
        },
      }),
      lost,
    );
    const loading = proxy.load();
    const rejected = expect(loading).rejects.toThrow("stopped");
    broken = true;
    await expect(echo(proxy, "hello")).rejects.toThrow("stopped");
    await rejected;
    expect(kill).toHaveBeenCalledTimes(1);
    expect(lost).toHaveBeenCalledTimes(1);
  });

  test("dispose rejects pending requests even when the killed child never emits exit", async () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const lost = vi.fn();
    const proxy = engineProcess(() => ({ postMessage: () => {}, kill }), lost);
    const loading = proxy.load();
    const rejected = expect(loading).rejects.toThrow("stopped");
    const disposing = proxy.dispose();
    await vi.advanceTimersByTimeAsync(DISPOSE_GRACE_MS);
    await disposing;
    await rejected;
    expect(kill).toHaveBeenCalledTimes(1);
    expect(lost).not.toHaveBeenCalled();
  });

  test("duplicate exit notifications only report the loss once", async () => {
    const lost = vi.fn();
    let events: Parameters<ForkEngine>[0] | undefined;
    const proxy = engineProcess((listeners) => {
      events = listeners;
      return { postMessage: () => {}, kill: () => {} };
    }, lost);
    const loading = proxy.load();
    events?.exit();
    events?.exit();
    await expect(loading).rejects.toThrow("stopped");
    expect(lost).toHaveBeenCalledTimes(1);
  });
});

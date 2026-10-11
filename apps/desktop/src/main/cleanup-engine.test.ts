import { MessageChannel, type MessagePort } from "node:worker_threads";

import type { CleanRequest, CleanResult, CleanupStyle } from "@voice/cleanup";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import {
  ABORT_GRACE_MS,
  createS1MiniProcess,
  DISPOSE_GRACE_MS,
  serve,
  type CleanupEngine,
} from "./cleanup-engine.ts";

const style: CleanupStyle = { styling: "formal" };
const modelPath = "/models/s1-mini.gguf";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

type Clean = {
  raw: string;
  style: CleanupStyle;
  request: CleanRequest | undefined;
  finish(result: CleanResult): void;
  fail(error: Error): void;
  aborted: Promise<void>;
};

// Cleans wait for the test to finish them. `wedged` ignores abort and dispose like a stuck model.
function fakeEngine({ wedged = false } = {}) {
  const calls = { modelPaths: [] as string[], loads: 0, disposes: 0, cleans: [] as Clean[] };
  const cleanStarted = deferred<Clean>();
  const disposeStarted = deferred();
  const create = ({ modelPath: path }: { modelPath: string }): CleanupEngine => {
    calls.modelPaths.push(path);
    return {
      async load() {
        calls.loads += 1;
      },
      clean: (raw, cleanStyle, request) =>
        new Promise((resolve, reject) => {
          const aborted = deferred();
          request?.signal?.addEventListener("abort", () => {
            aborted.resolve();
            if (!wedged) reject(request.signal?.reason);
          });
          const clean = { raw, style: cleanStyle, request, finish: resolve, fail: reject };
          calls.cleans.push({ ...clean, aborted: aborted.promise });
          cleanStarted.resolve(calls.cleans.at(-1)!);
        }),
      async dispose() {
        calls.disposes += 1;
        disposeStarted.resolve();
        if (wedged) await new Promise(() => {});
      },
    };
  };
  return {
    calls,
    create,
    cleanStarted: cleanStarted.promise,
    disposeStarted: disposeStarted.promise,
  };
}

const ports: MessagePort[] = [];
afterEach(() => {
  for (const port of ports.splice(0)) port.close();
  vi.useRealTimers();
});

// Main holds port1 as the utility process handle; the child serves on port2 as its parentPort.
function connect(engine = fakeEngine()) {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  const received: unknown[] = [];
  serve(
    {
      on: (_event, listener) =>
        port2.on("message", (data: unknown) => {
          received.push(data);
          listener({ data });
        }),
      postMessage: (message) => port2.postMessage(message),
    },
    engine.create,
  );
  const lost: string[] = [];
  const lostSignal = deferred<string>();
  const exited = deferred();
  port1.on("close", () => exited.resolve());
  let kills = 0;
  const proxy = createS1MiniProcess({
    modelPath,
    fork: (events) => {
      port1.on("message", events.message);
      port1.on("close", () => events.exit(kills > 0 ? 15 : 1));
      return {
        postMessage: (message) => port1.postMessage(message),
        kill: () => {
          kills += 1;
          port1.close();
        },
      };
    },
    onLost: (message) => {
      lost.push(message);
      lostSignal.resolve(message);
    },
  });
  return {
    proxy,
    engine,
    received,
    lost,
    lostSignal: lostSignal.promise,
    exited: exited.promise,
    kills: () => kills,
    crash: () => port2.close(),
    childPort: port2,
  };
}

describe("cleanup engine process", () => {
  test("load and clean cross to the engine and the result comes back", async () => {
    const { proxy, engine } = connect();

    await proxy.load();
    const cleaning = proxy.clean("um hello there", style, { budgetMs: 4200 });
    const clean = await engine.cleanStarted;
    clean.finish({ text: "Hello there.", chunks: 2, cleaned: 1 });

    await expect(cleaning).resolves.toEqual({ text: "Hello there.", chunks: 2, cleaned: 1 });
    expect(engine.calls.modelPaths).toEqual([modelPath]);
    expect(engine.calls.loads).toBe(1);
    expect(clean.raw).toBe("um hello there");
    expect(clean.style).toEqual(style);
    expect(clean.request?.budgetMs).toBe(4200);
  });

  test("a clean without a budget reaches the engine without one", async () => {
    const { proxy, engine } = connect();
    await proxy.load();

    const cleaning = proxy.clean("warm up", style);
    const clean = await engine.cleanStarted;
    clean.finish({ text: "Warm up.", chunks: 1, cleaned: 1 });

    await expect(cleaning).resolves.toEqual({ text: "Warm up.", chunks: 1, cleaned: 1 });
    expect(clean.request).not.toHaveProperty("budgetMs");
  });

  test("an engine error comes back with its name and message", async () => {
    const { proxy, engine } = connect();
    await proxy.load();

    const cleaning = proxy.clean("hello", style);
    (await engine.cleanStarted).fail(
      Object.assign(new Error("context full"), { name: "LlamaError" }),
    );

    const error = await cleaning.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "LlamaError", message: "context full" });
  });

  test("abort rejects at once with the reason and withdraws the clean in the child", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { proxy, engine, kills, lost } = connect();
    await proxy.load();
    const controller = new AbortController();
    const cleaning = proxy.clean("hello", style, { budgetMs: 4200, signal: controller.signal });
    const clean = await engine.cleanStarted;

    const reason = new Error("session cancelled");
    controller.abort(reason);

    await expect(cleaning).rejects.toBe(reason);
    await clean.aborted;
    // Replies arrive in order, so once this round trip ends the child's reply to the abort is in.
    await proxy.load();
    vi.advanceTimersByTime(ABORT_GRACE_MS);
    expect(kills()).toBe(0);
    expect(lost).toEqual([]);
  });

  test("an already aborted signal rejects without reaching the engine", async () => {
    const { proxy, engine } = connect();
    await proxy.load();
    const reason = new Error("gone");

    await expect(proxy.clean("hello", style, { signal: AbortSignal.abort(reason) })).rejects.toBe(
      reason,
    );
    await proxy.load();
    expect(engine.calls.cleans).toEqual([]);
  });

  test("a child that ignores abort is killed after the grace and reported lost", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { proxy, engine, kills, lostSignal } = connect(fakeEngine({ wedged: true }));
    await proxy.load();
    const controller = new AbortController();
    const cleaning = proxy.clean("hello", style, { signal: controller.signal });
    const clean = await engine.cleanStarted;

    controller.abort(new Error("cancelled"));
    await expect(cleaning).rejects.toThrow("cancelled");
    await clean.aborted;
    vi.advanceTimersByTime(ABORT_GRACE_MS - 1);
    expect(kills()).toBe(0);
    vi.advanceTimersByTime(1);

    expect(kills()).toBe(1);
    await expect(lostSignal).resolves.toMatch(/stopped/);
  });

  test("a child exit rejects every pending call, reports lost, and refuses later calls", async () => {
    const { proxy, engine, crash, lostSignal, lost } = connect();
    await proxy.load();
    const first = proxy.clean("one", style);
    await engine.cleanStarted;
    const second = proxy.clean("two", style);

    crash();

    const message = await lostSignal;
    await expect(first).rejects.toThrow(message);
    await expect(second).rejects.toThrow(message);
    await expect(proxy.clean("three", style)).rejects.toThrow(message);
    await expect(proxy.load()).rejects.toThrow(message);
    expect(lost).toEqual([message]);
  });

  test("dispose frees the engine, then ends the child without reporting it lost", async () => {
    const { proxy, engine, kills, lost, exited } = connect();
    await proxy.load();

    await proxy.dispose();
    await exited;

    expect(engine.calls.disposes).toBe(1);
    expect(kills()).toBe(1);
    expect(lost).toEqual([]);
  });

  test("dispose kills a child that does not free the engine within the grace", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { proxy, engine, kills, lost, exited } = connect(fakeEngine({ wedged: true }));
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

  test("malformed messages are ignored at both ends", async () => {
    const { proxy, engine, received, childPort } = connect();
    await proxy.load();
    const cleaning = proxy.clean("hello", style);
    const clean = await engine.cleanStarted;
    const sent = received.at(-1) as { id: unknown };

    childPort.postMessage({ type: "cleaned", id: sent.id, result: { text: 42 } });
    childPort.postMessage("cleaned");
    received.length = 0;
    const port = ports[0]!;
    port.postMessage({ type: "clean", id: "x", raw: "boom", style });
    port.postMessage({ type: "load", id: 99 });
    clean.finish({ text: "Hello.", chunks: 1, cleaned: 1 });

    await expect(cleaning).resolves.toEqual({ text: "Hello.", chunks: 1, cleaned: 1 });
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(engine.calls.cleans).toHaveLength(1);
    expect(engine.calls.loads).toBe(1);
  });
});

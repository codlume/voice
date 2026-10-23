import { MessageChannel, type MessagePort } from "node:worker_threads";

import type { CleanRequest, CleanResult, CleanupStyle } from "@voice/cleanup";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { createS1MiniProcess, serve, type CleanupEngine } from "./cleanup-engine.ts";

const style: CleanupStyle = { style: "veryCasual", layout: "email" };
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
};

function fakeEngine() {
  const calls = {
    modelPaths: [] as string[],
    loads: 0,
    disposes: 0,
    busy: [] as number[],
    cleans: [] as Clean[],
  };
  const cleanStarted = deferred<Clean>();
  const busied = deferred<number>();
  const create = ({ modelPath: path }: { modelPath: string }): CleanupEngine => {
    calls.modelPaths.push(path);
    return {
      async load() {
        calls.loads += 1;
      },
      keepGpuBusy(ms) {
        calls.busy.push(ms);
        busied.resolve(ms);
      },
      clean: (raw, cleanStyle, request) =>
        new Promise((resolve) => {
          calls.cleans.push({ raw, style: cleanStyle, request, finish: resolve });
          cleanStarted.resolve(calls.cleans.at(-1)!);
        }),
      async dispose() {
        calls.disposes += 1;
      },
    };
  };
  return {
    calls,
    create,
    cleanStarted: cleanStarted.promise,
    busied: busied.promise,
  };
}

const ports: MessagePort[] = [];
afterEach(() => {
  for (const port of ports.splice(0)) port.close();
  vi.useRealTimers();
});

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
  const proxy = createS1MiniProcess({
    modelPath,
    fork: (events) => {
      port1.on("message", events.message);
      port1.on("close", events.exit);
      return {
        postMessage: (message) => port1.postMessage(message),
        kill: () => port1.close(),
      };
    },
    onLost: () => {},
  });
  return { proxy, engine, received };
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

  test("keepGpuBusy crosses to the engine, needs no reply, and is not sent once dispose starts", async () => {
    const { proxy, engine, received } = connect();
    await proxy.load();

    proxy.keepGpuBusy(1000);
    await expect(engine.busied).resolves.toBe(1000);
    const disposing = proxy.dispose();
    proxy.keepGpuBusy(1000);
    await disposing;

    expect(received.map((message) => (message as { type: string }).type)).toEqual([
      "load",
      "keepGpuBusy",
      "dispose",
    ]);
    expect(engine.calls.busy).toEqual([1000]);
  });

  test("malformed messages are ignored at both ends", async () => {
    const { proxy, engine, received } = connect();
    const [port1, port2]: (MessagePort | undefined)[] = ports;
    await proxy.load();
    const cleaning = proxy.clean("hello", style);
    const clean = await engine.cleanStarted;
    const sent = received.at(-1) as { id: unknown };

    port2?.postMessage({ type: "cleaned", id: sent.id, result: { text: 42 } });
    port2?.postMessage("cleaned");
    received.length = 0;
    port1?.postMessage({ type: "clean", id: "x", raw: "boom", style });
    port1?.postMessage({ type: "load", id: 99 });
    clean.finish({ text: "Hello.", chunks: 1, cleaned: 1 });

    await expect(cleaning).resolves.toEqual({ text: "Hello.", chunks: 1, cleaned: 1 });
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(engine.calls.cleans).toHaveLength(1);
    expect(engine.calls.loads).toBe(1);
  });
});

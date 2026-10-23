// What every llama-backed engine needs around its model: a memoised load, one task at a time,
// and a dispose that withdraws queued and running work before it frees the model.
import type { Llama, LlamaContext, LlamaModel } from "node-llama-cpp";

type Opened = { llama: Llama; model: LlamaModel };

export function llamaHost<E extends Opened>(open: () => Promise<E>, disposedMessage: string) {
  let engine: Promise<E> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let disposal = new AbortController();

  // A failed load is forgotten, so the next call tries again.
  function load(): Promise<E> {
    if (engine) return engine;
    const loading: Promise<E> = open().catch((error: unknown) => {
      if (engine === loading) engine = undefined;
      throw error;
    });
    engine = loading;
    return loading;
  }

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  }

  return {
    load,
    serialize,
    // The engine once a load has started, without starting one.
    current: () => engine,
    // Aborts when the caller's signal does or when dispose is called.
    withdrawal: (signal?: AbortSignal) =>
      signal ? AbortSignal.any([signal, disposal.signal]) : disposal.signal,
    // Work queued after a dispose loads the model again: the reset runs inside the queue.
    dispose: () => {
      disposal.abort(new Error(disposedMessage));
      return serialize(async () => {
        const pending = engine;
        engine = undefined;
        disposal = new AbortController();
        const loaded = await pending?.catch(() => undefined);
        await loaded?.model.dispose();
        await loaded?.llama.dispose();
      });
    },
  };
}

type LlamaCpp = typeof import("node-llama-cpp");

// Frees llama if the model or its context fails to open.
export async function openLlama<T>(
  { modelPath, contextSize }: { modelPath: string; contextSize: number },
  build: (llamaCpp: LlamaCpp, context: LlamaContext) => T,
): Promise<Opened & T> {
  // A static import breaks the CJS Electron bundle, because node-llama-cpp uses top-level await.
  const llamaCpp = await import("node-llama-cpp");
  const llama = await llamaCpp.getLlama();
  try {
    const model = await llama.loadModel({ modelPath });
    const context = await model.createContext({ contextSize });
    return { llama, model, ...build(llamaCpp, context) };
  } catch (error) {
    await llama.dispose();
    throw error;
  }
}

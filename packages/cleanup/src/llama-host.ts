import type { Llama, LlamaContext, LlamaModel } from "node-llama-cpp";

type Opened = { llama: Llama; model: LlamaModel };

export function llamaHost<E extends Opened>(open: () => Promise<E>, disposedMessage: string) {
  let engine: Promise<E> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let disposal = new AbortController();

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
    current: () => engine,
    withdrawal: (signal?: AbortSignal) =>
      signal ? AbortSignal.any([signal, disposal.signal]) : disposal.signal,
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

type LoadOptions = { modelPath: string; contextSize: number; gpuLayers?: number | undefined };

export async function openLlama<T>(
  options: LoadOptions,
  build: (llamaCpp: LlamaCpp, context: LlamaContext) => T,
): Promise<Opened & T> {
  // A static import breaks the CJS Electron bundle, because node-llama-cpp uses top-level await.
  const llamaCpp = await import("node-llama-cpp");
  const llama = await llamaCpp.getLlama();
  try {
    const model = await loadModel(llamaCpp, llama, options);
    const context = await model.createContext({ contextSize: options.contextSize });
    return { llama, model, ...build(llamaCpp, context) };
  } catch (error) {
    await llama.dispose();
    throw error;
  }
}

// Naming the layers and the context lets node-llama-cpp skip its layer and context-size searches.
// Lazy mode leaves a table the model reads a row at a time, like Gemma 4's per-layer embeddings,
// on disk until a row is needed.
async function loadModel(
  llamaCpp: LlamaCpp,
  llama: Llama,
  { modelPath, contextSize, gpuLayers }: LoadOptions,
): Promise<LlamaModel> {
  if (gpuLayers === undefined) return llama.loadModel({ modelPath });
  const lazy = { modelPath, useMmap: true, lazyMode: true };
  try {
    return await llama.loadModel({
      ...lazy,
      gpuLayers: { min: gpuLayers, max: gpuLayers, fitContext: { contextSize } },
    });
  } catch (error) {
    if (!(error instanceof llamaCpp.InsufficientMemoryError)) throw error;
    return llama.loadModel(lazy);
  }
}

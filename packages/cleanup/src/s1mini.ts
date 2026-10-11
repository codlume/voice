import type { Llama, LlamaCompletion, LlamaModel } from "node-llama-cpp";

import { type Chunk, chunkTranscript, stitch } from "./chunk.ts";
import { assertPlausibleCleanup, MAX_OUTPUT_RATIO } from "./plausibility.ts";
import { buildS1MiniPrompt, type CleanupStyle } from "./prompt.ts";

const CONTEXT_SIZE = 4096;
// Longer chunks make S1-mini skip or loop over lines, so the guard rejects them and the user gets raw text.
const CHUNK_TOKENS = 400;
const OUTPUT_TOKEN_SLACK = 32;

export type Generation = { chunk: string; output: string; truncated: boolean };
type Cleaned = Omit<Generation, "chunk"> & { chunk: Chunk };

export type S1Mini = {
  load(): Promise<void>;
  // Aborting the signal stops generation within a token and rejects with the signal's reason.
  clean(raw: string, style: CleanupStyle, signal?: AbortSignal): Promise<string>;
  // What the model returned for each chunk, before the plausibility guard. For calibration.
  generate(raw: string, style: CleanupStyle, signal?: AbortSignal): Promise<Generation[]>;
  // Aborts any queued or running clean, then frees the model.
  dispose(): Promise<void>;
};

type Engine = { llama: Llama; model: LlamaModel; completion: LlamaCompletion };

export function createS1Mini({ modelPath }: { modelPath: string }): S1Mini {
  let engine: Promise<Engine> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let disposal = new AbortController();

  function load(): Promise<Engine> {
    if (engine) return engine;
    const loading: Promise<Engine> = openEngine(modelPath).catch((error: unknown) => {
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

  async function* generate(
    raw: string,
    style: CleanupStyle,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<Cleaned> {
    const abort = signal ? AbortSignal.any([signal, disposal.signal]) : disposal.signal;
    abort.throwIfAborted();
    const { model, completion } = await load();
    const countTokens = (text: string) => model.tokenize(text).length;
    for (const chunk of chunkTranscript(raw, CHUNK_TOKENS, countTokens)) {
      abort.throwIfAborted();
      // Special-token parsing makes <|im_start|> and friends the trained control tokens, not literal text.
      const prompt = model.tokenize(buildS1MiniPrompt(chunk.text, style), true);
      const { response, metadata } = await completion.generateCompletionWithMeta(prompt, {
        signal: abort,
        temperature: 0,
        customStopTriggers: ["<|im_end|>"],
        maxTokens: Math.min(
          MAX_OUTPUT_RATIO * countTokens(chunk.text) + OUTPUT_TOKEN_SLACK,
          CONTEXT_SIZE - prompt.length,
        ),
      });
      yield { chunk, output: response.trim(), truncated: metadata.stopReason === "maxTokens" };
    }
  }

  return {
    load: async () => {
      await load();
    },
    clean: (raw, style, signal) =>
      serialize(async () => {
        const chunks: Chunk[] = [];
        const outputs: string[] = [];
        for await (const { chunk, output, truncated } of generate(raw, style, signal)) {
          assertPlausibleCleanup(chunk.text, output, truncated);
          chunks.push(chunk);
          outputs.push(output);
        }
        return stitch(raw, chunks, outputs);
      }),
    generate: (raw, style, signal) =>
      serialize(() =>
        Array.fromAsync(generate(raw, style, signal), ({ chunk, ...rest }) => ({
          chunk: chunk.text,
          ...rest,
        })),
      ),
    dispose: () => {
      disposal.abort(new Error("Cleanup model disposed"));
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

async function openEngine(modelPath: string): Promise<Engine> {
  // A static import breaks the CJS Electron bundle, because node-llama-cpp uses top-level await.
  const { getLlama, LlamaCompletion } = await import("node-llama-cpp");
  const llama = await getLlama();
  try {
    const model = await llama.loadModel({ modelPath });
    const context = await model.createContext({ contextSize: CONTEXT_SIZE });
    return {
      llama,
      model,
      completion: new LlamaCompletion({ contextSequence: context.getSequence() }),
    };
  } catch (error) {
    await llama.dispose();
    throw error;
  }
}

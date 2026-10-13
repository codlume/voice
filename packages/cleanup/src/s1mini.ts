import type { Llama, LlamaCompletion, LlamaModel } from "node-llama-cpp";

import { type Chunk, chunkTranscript, stitch } from "./chunk.ts";
import { assertPlausibleCleanup, MAX_OUTPUT_RATIO } from "./plausibility.ts";
import { buildS1MiniPrompt, type CleanupStyle } from "./prompt.ts";

const CONTEXT_SIZE = 4096;
// Longer chunks make S1-mini skip or loop over lines, so the guard rejects them and the user gets raw text.
export const CHUNK_TOKENS = 400;
const OUTPUT_TOKEN_SLACK = 32;
const MIN_TOKENS_FOR_RATE_ESTIMATE = 128;
const WARM_GAP_MS = 25;
const WARM_STYLE: CleanupStyle = { styling: "semi-formal" };

export type Generation = { chunk: string; output: string; truncated: boolean };
type Output = Omit<Generation, "chunk">;

export type CleanRequest = { budgetMs?: number; signal?: AbortSignal };
export type CleanResult = { text: string; chunks: number; cleaned: number };

export type S1Mini = {
  load(): Promise<void>;
  // Keeps the GPU busy with one-token generations for up to ms, or until a clean is requested.
  // A no-op before load. Another call while warming moves the deadline.
  warm(ms: number): void;
  // Aborting the signal or disposing withdraws the clean: generation stops within a token and the
  // promise rejects with the reason. Running out of budget is not an error: the chunk in flight
  // stops and every chunk not cleaned comes back as the user's exact words. The budget counts
  // from the call, so time queued behind another clean is inside it.
  clean(raw: string, style: CleanupStyle, request?: CleanRequest): Promise<CleanResult>;
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
  let msPerToken: number | undefined;
  let warmUntil = 0;
  let warming = false;

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

  const withdrawal = (signal: AbortSignal | undefined) =>
    signal ? AbortSignal.any([signal, disposal.signal]) : disposal.signal;

  // The GPU clocks down while the user speaks, so the first clean after that idle pays ~60 ms of
  // ramp-up. Without the gap the loop slows the speech model running alongside it by ~10 ms.
  async function keepWarm() {
    warming = true;
    try {
      while (engine && Date.now() < warmUntil) {
        await serialize(async () => {
          if (!engine || Date.now() >= warmUntil) return;
          const { model, completion } = await engine;
          await completion.generateCompletionWithMeta(
            model.tokenize(buildS1MiniPrompt("ok", WARM_STYLE), true),
            { signal: disposal.signal, temperature: 0, maxTokens: 1 },
          );
        }).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, WARM_GAP_MS));
      }
    } finally {
      warming = false;
    }
  }

  async function prepare(raw: string, style: CleanupStyle, abort: AbortSignal) {
    abort.throwIfAborted();
    const { model, completion } = await load();
    const countTokens = (text: string) => model.tokenize(text).length;
    const chunks = chunkTranscript(raw, CHUNK_TOKENS, countTokens);
    const run = async (chunk: Chunk, signal: AbortSignal): Promise<Output> => {
      // Special-token parsing makes <|im_start|> and friends the trained control tokens, not literal text.
      const prompt = model.tokenize(buildS1MiniPrompt(chunk.text, style), true);
      const { response, metadata } = await completion.generateCompletionWithMeta(prompt, {
        signal,
        temperature: 0,
        customStopTriggers: ["<|im_end|>"],
        maxTokens: Math.min(
          MAX_OUTPUT_RATIO * countTokens(chunk.text) + OUTPUT_TOKEN_SLACK,
          CONTEXT_SIZE - prompt.length,
        ),
      });
      return { output: response.trim(), truncated: metadata.stopReason === "maxTokens" };
    };
    return { chunks, countTokens, run };
  }

  return {
    load: async () => {
      await load();
    },
    warm: (ms) => {
      if (!engine) return;
      warmUntil = Math.max(warmUntil, Date.now() + ms);
      if (!warming) void keepWarm();
    },
    clean: (raw, style, { budgetMs, signal } = {}) => {
      warmUntil = 0;
      const deadline = new AbortController();
      const deadlineAt = budgetMs === undefined ? Infinity : Date.now() + budgetMs;
      const timer =
        budgetMs === undefined ? undefined : setTimeout(() => deadline.abort(), budgetMs);
      return serialize(async () => {
        const withdraw = withdrawal(signal);
        const { chunks, countTokens, run } = await prepare(raw, style, withdraw);
        const stop = AbortSignal.any([withdraw, deadline.signal]);
        const outputs: (string | undefined)[] = [];
        for (const chunk of chunks) {
          withdraw.throwIfAborted();
          const tokens = countTokens(chunk.text);
          const predictedMs = msPerToken === undefined ? 0 : msPerToken * tokens;
          if (deadline.signal.aborted || predictedMs > deadlineAt - Date.now()) break;
          const startedAt = Date.now();
          let generation: Output;
          try {
            generation = await run(chunk, stop);
          } catch (error) {
            if (deadline.signal.aborted && !withdraw.aborted) break;
            throw error;
          }
          if (tokens >= MIN_TOKENS_FOR_RATE_ESTIMATE)
            msPerToken = (Date.now() - startedAt) / tokens;
          outputs.push(guarded(chunk.text, generation));
        }
        return {
          text: stitch(raw, chunks, outputs),
          chunks: chunks.length,
          cleaned: outputs.filter((output) => output !== undefined).length,
        };
      }).finally(() => clearTimeout(timer));
    },
    generate: (raw, style, signal) => {
      warmUntil = 0;
      return serialize(async () => {
        const abort = withdrawal(signal);
        const { chunks, run } = await prepare(raw, style, abort);
        const generations: Generation[] = [];
        for (const chunk of chunks) {
          abort.throwIfAborted();
          generations.push({ chunk: chunk.text, ...(await run(chunk, abort)) });
        }
        return generations;
      });
    },
    dispose: () => {
      warmUntil = 0;
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

function guarded(input: string, { output, truncated }: Output): string | undefined {
  try {
    assertPlausibleCleanup(input, output, truncated);
    return output;
  } catch {
    return undefined;
  }
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

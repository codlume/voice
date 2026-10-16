import type { Llama, LlamaCompletion, LlamaModel } from "node-llama-cpp";

import { type Chunk, chunkTranscript, stitch } from "./chunk.ts";
import { assertPlausibleCleanup, MAX_OUTPUT_RATIO } from "./plausibility.ts";
import { buildS1MiniPrompt, s1Control, type S1Control } from "./prompt.ts";
import { type CleanupStyle, finishOutputs } from "./style.ts";

const CONTEXT_SIZE = 4096;
// Longer chunks make S1-mini skip or loop over lines, so the guard rejects them and the user gets raw text.
export const CHUNK_TOKENS = 400;
const OUTPUT_TOKEN_SLACK = 32;
const MIN_TOKENS_FOR_RATE_ESTIMATE = 128;
const BUSY_GAP_MS = 25;
const BUSY_CONTROL: S1Control = { styling: "semi-formal", context: "general" };

export type Generation = { chunk: string; output: string; truncated: boolean };
type Output = Omit<Generation, "chunk">;

export type CleanRequest = { budgetMs?: number; signal?: AbortSignal };
export type CleanResult = { text: string; chunks: number; cleaned: number };

export type S1Mini = {
  load(): Promise<void>;
  // Keeps the GPU busy with one-token generations for the next ms, or until a clean, generate, or
  // dispose is requested. 0 stops it. A no-op until load() has been called.
  keepGpuBusy(ms: number): void;
  // Aborting the signal or disposing withdraws the clean: generation stops within a token and the
  // promise rejects with the reason. Running out of budget is not an error: the chunk in flight
  // stops and every chunk not cleaned comes back as the user's exact words. The budget counts
  // from the call, so time queued behind another clean is inside it.
  clean(raw: string, style: CleanupStyle, request?: CleanRequest): Promise<CleanResult>;
  // What the model returned for each chunk under an exact S1 control line, before the
  // plausibility guard and the style's finish. For calibration.
  generate(raw: string, control: S1Control, signal?: AbortSignal): Promise<Generation[]>;
  // Aborts any queued or running clean, then frees the model.
  dispose(): Promise<void>;
};

type Engine = { llama: Llama; model: LlamaModel; completion: LlamaCompletion };

export function createS1Mini({ modelPath }: { modelPath: string }): S1Mini {
  let engine: Promise<Engine> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let disposal = new AbortController();
  let msPerToken: number | undefined;
  let busyUntil = 0;
  let busy = false;

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

  // Real work ends the busy loop, so it never queues behind it.
  function work<T>(task: () => Promise<T>): Promise<T> {
    busyUntil = 0;
    return serialize(task);
  }

  const withdrawal = (signal: AbortSignal | undefined) =>
    signal ? AbortSignal.any([signal, disposal.signal]) : disposal.signal;

  const busyEngine = () => (Date.now() < busyUntil ? engine : undefined);

  // The GPU clocks down while the user speaks: a clean after 5 s of idle measured 216 ms against
  // 155 ms right after another. Without the gap the loop slowed the speech model by ~10 ms.
  async function busyLoop() {
    busy = true;
    try {
      while (busyEngine()) {
        await serialize(async () => {
          const current = busyEngine();
          if (!current) return;
          const { model, completion } = await current;
          await completion.generateCompletionWithMeta(
            model.tokenize(buildS1MiniPrompt("ok", BUSY_CONTROL), true),
            { signal: disposal.signal, temperature: 0, maxTokens: 1 },
          );
        }).catch(() => {
          busyUntil = 0;
        });
        await new Promise((resolve) => setTimeout(resolve, BUSY_GAP_MS));
      }
    } finally {
      busy = false;
    }
  }

  async function prepare(raw: string, abort: AbortSignal) {
    abort.throwIfAborted();
    const { model, completion } = await load();
    const countTokens = (text: string) => model.tokenize(text).length;
    const chunks = chunkTranscript(raw, CHUNK_TOKENS, countTokens);
    const run = async (chunk: Chunk, control: S1Control, signal: AbortSignal): Promise<Output> => {
      // Special-token parsing makes <|im_start|> and friends the trained control tokens, not literal text.
      const prompt = model.tokenize(buildS1MiniPrompt(chunk.text, control), true);
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
    keepGpuBusy: (ms) => {
      if (!engine) return;
      busyUntil = Date.now() + ms;
      if (!busy) void busyLoop();
    },
    clean: (raw, style, { budgetMs, signal } = {}) => {
      const deadline = new AbortController();
      const deadlineAt = budgetMs === undefined ? Infinity : Date.now() + budgetMs;
      const timer =
        budgetMs === undefined ? undefined : setTimeout(() => deadline.abort(), budgetMs);
      return work(async () => {
        const withdraw = withdrawal(signal);
        const { chunks, countTokens, run } = await prepare(raw, withdraw);
        const control = s1Control(style, raw, chunks.length);
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
            generation = await run(chunk, control, stop);
          } catch (error) {
            if (deadline.signal.aborted && !withdraw.aborted) break;
            throw error;
          }
          if (tokens >= MIN_TOKENS_FOR_RATE_ESTIMATE)
            msPerToken = (Date.now() - startedAt) / tokens;
          outputs.push(guarded(chunk.text, generation));
        }
        return {
          text: stitch(raw, chunks, finishOutputs(style.style, outputs, chunks.length)),
          chunks: chunks.length,
          cleaned: outputs.filter((output) => output !== undefined).length,
        };
      }).finally(() => clearTimeout(timer));
    },
    generate: (raw, control, signal) =>
      work(async () => {
        const abort = withdrawal(signal);
        const { chunks, run } = await prepare(raw, abort);
        const generations: Generation[] = [];
        for (const chunk of chunks) {
          abort.throwIfAborted();
          generations.push({ chunk: chunk.text, ...(await run(chunk, control, abort)) });
        }
        return generations;
      }),
    dispose: () => {
      disposal.abort(new Error("Cleanup model disposed"));
      return work(async () => {
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

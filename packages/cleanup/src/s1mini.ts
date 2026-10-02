import type { Llama, LlamaCompletion, LlamaModel } from "node-llama-cpp";

import { chunkTranscript } from "./chunk.ts";
import { buildS1MiniPrompt, type CleanupStyle } from "./prompt.ts";

const CONTEXT_SIZE = 4096;
const CHUNK_TOKENS = 1000;
const MAX_OUTPUT_RATIO = 3;
const OUTPUT_TOKEN_SLACK = 32;

export type S1Mini = {
  load(): Promise<void>;
  // Aborting the signal stops generation within a token and rejects with the signal's reason.
  clean(raw: string, style: CleanupStyle, signal?: AbortSignal): Promise<string>;
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

  return {
    load: async () => {
      await load();
    },
    clean: (raw, style, signal) =>
      serialize(async () => {
        const abort = signal ? AbortSignal.any([signal, disposal.signal]) : disposal.signal;
        abort.throwIfAborted();
        const { model, completion } = await load();
        const countTokens = (text: string) => model.tokenize(text).length;
        const outputs: string[] = [];
        for (const chunk of chunkTranscript(raw, CHUNK_TOKENS, countTokens)) {
          abort.throwIfAborted();
          // Special-token parsing makes <|im_start|> and friends the trained control tokens, not literal text.
          const prompt = model.tokenize(buildS1MiniPrompt(chunk, style), true);
          const { response, metadata } = await completion.generateCompletionWithMeta(prompt, {
            signal: abort,
            temperature: 0,
            customStopTriggers: ["<|im_end|>"],
            maxTokens: Math.min(
              MAX_OUTPUT_RATIO * countTokens(chunk) + OUTPUT_TOKEN_SLACK,
              CONTEXT_SIZE - prompt.length,
            ),
          });
          const output = response.trim();
          assertPlausibleCleanup(chunk, output, metadata.stopReason === "maxTokens");
          if (output) outputs.push(output);
        }
        return outputs.join(" ");
      }),
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

const CHAT_OPENER_SPELLINGS = [
  ["sorry"],
  ["im sorry", "i am sorry"],
  ["i cannot", "i cant"],
  ["as an ai"],
  ["sure"],
  ["certainly"],
  ["of course"],
  ["here is", "heres"],
];

const words = (text: string) =>
  text
    .toLowerCase()
    .replaceAll(/['’]/g, "")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const MAX_FILLER_WORDS = 20;

export function assertPlausibleCleanup(input: string, output: string, truncated: boolean): void {
  if (truncated) throw new Error("Cleanup output was cut off at the token limit");
  if (!output && words(input).split(" ").length > MAX_FILLER_WORDS)
    throw new Error("Cleanup output is empty for speech too long to be filler");
  if (output.length > MAX_OUTPUT_RATIO * input.length)
    throw new Error(`Cleanup output is over ${MAX_OUTPUT_RATIO}x the input length`);
  if (/<\/?think>|<\|im_(start|end)\|>/.test(output))
    throw new Error("Cleanup output contains chat template markup");
  const said = ` ${words(input)} `;
  const cleaned = ` ${words(output)} `;
  const opener = CHAT_OPENER_SPELLINGS.find((group) =>
    group.some((phrase) => cleaned.startsWith(` ${phrase} `)),
  );
  if (opener && !opener.some((phrase) => said.includes(` ${phrase} `)))
    throw new Error("Cleanup output reads like a chat reply");
}

// The transform adapter. Everything model-specific stays in this directory: the prompt, the chat
// wrapper, the token budget and the output guard. Callers see requests and results.
import type { ChatWrapper, Llama, LlamaChatSession, LlamaModel } from "node-llama-cpp";

import { budget, countWords } from "./budget.ts";
import { guard } from "./guard.ts";
import { TRANSFORM_MODEL } from "./model.ts";
import { SYSTEM_PROMPT, userMessage } from "./prompt.ts";

export type TransformFailure =
  | { kind: "tooLong"; maxWords: number }
  | { kind: "timedOut" }
  // The guard refused the model's output.
  | { kind: "rejected" };

export type TransformResult = { ok: true; text: string } | { ok: false; failure: TransformFailure };

export type TransformRequest = {
  instruction: string;
  text: string;
  // Adds the dictation line to the prompt, so dictated commands stay words.
  dictation: boolean;
  // Counts from the call, so time queued behind another run is inside it.
  budgetMs: number;
  signal: AbortSignal;
};

export type TransformEngine = {
  load(): Promise<void>;
  // One run at a time. Expected failures resolve as data; aborting rejects with the signal's
  // reason, and a broken model rejects with its error.
  transform(request: TransformRequest): Promise<TransformResult>;
  // Aborts queued and running work, then frees the model.
  dispose(): Promise<void>;
};

type Engine = { llama: Llama; model: LlamaModel; session: LlamaChatSession };

const TIMED_OUT: TransformResult = { ok: false, failure: { kind: "timedOut" } };

export function createTransformEngine({ modelPath }: { modelPath: string }): TransformEngine {
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

  async function attempt(
    request: TransformRequest,
    deadline: AbortSignal,
  ): Promise<TransformResult> {
    const withdraw = AbortSignal.any([request.signal, disposal.signal]);
    withdraw.throwIfAborted();
    const { model, session } = await load();
    withdraw.throwIfAborted();
    if (deadline.aborted) return TIMED_OUT;

    // A fresh chat on the one sequence: a new sequence per run fails with "No sequences left".
    await session.sequence.clearHistory();
    session.resetChatHistory();
    const user = userMessage(request);
    const plan = budget(
      {
        words: countWords(request.text),
        textTokens: model.tokenize(request.text).length,
        promptTokens: promptTokens(session.chatWrapper, model, user),
      },
      TRANSFORM_MODEL,
    );
    if (!plan.ok) return { ok: false, failure: { kind: "tooLong", maxWords: plan.maxWords } };

    let output: { responseText: string; stopReason: string };
    try {
      output = await session.promptWithMeta(user, {
        temperature: 0,
        maxTokens: plan.maxTokens,
        signal: AbortSignal.any([withdraw, deadline]),
      });
    } catch (error) {
      withdraw.throwIfAborted();
      if (deadline.aborted) return TIMED_OUT;
      throw error;
    }
    withdraw.throwIfAborted();
    const verdict = guard(request.text, output.responseText, {
      truncated: output.stopReason === "maxTokens",
      dictation: request.dictation,
    });
    return verdict.ok
      ? { ok: true, text: verdict.text }
      : { ok: false, failure: { kind: "rejected" } };
  }

  return {
    load: async () => {
      await load();
    },
    transform: (request) => {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), request.budgetMs);
      return serialize(() => attempt(request, deadline.signal)).finally(() => clearTimeout(timer));
    },
    dispose: () => {
      disposal.abort(new Error("Transform model disposed"));
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

function promptTokens(chatWrapper: ChatWrapper, model: LlamaModel, user: string): number {
  const { contextText } = chatWrapper.generateContextState({
    chatHistory: [
      { type: "system", text: SYSTEM_PROMPT },
      { type: "user", text: user },
      { type: "model", response: [] },
    ],
  });
  return contextText.tokenize(model.tokenizer).length;
}

async function openEngine(modelPath: string): Promise<Engine> {
  // A static import breaks the CJS Electron bundle, because node-llama-cpp uses top-level await.
  const { getLlama, Gemma4ChatWrapper, LlamaChatSession } = await import("node-llama-cpp");
  const llama = await getLlama();
  try {
    const model = await llama.loadModel({ modelPath });
    const context = await model.createContext({ contextSize: TRANSFORM_MODEL.contextSize });
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      // Thinking off, as #311 measured it.
      chatWrapper: new Gemma4ChatWrapper({ reasoning: false }),
      systemPrompt: SYSTEM_PROMPT,
    });
    return { llama, model, session };
  } catch (error) {
    await llama.dispose();
    throw error;
  }
}

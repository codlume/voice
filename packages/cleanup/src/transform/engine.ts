import type { ChatWrapper, GbnfJsonObjectSchema, LlamaModel } from "node-llama-cpp";

import { llamaHost, openLlama } from "../llama-host.ts";

import { countWords } from "../words.ts";
import { budget } from "./budget.ts";
import { guard } from "./guard.ts";
import { TRANSFORM_MODEL } from "./model.ts";
import { SYSTEM_PROMPT, userMessage } from "./prompt.ts";

export type TransformFailure =
  | { kind: "tooLong"; maxWords: number }
  | { kind: "timedOut" }
  | { kind: "rejected" };

export type TransformResult = { ok: true; text: string } | { ok: false; failure: TransformFailure };

export type TransformRequest = {
  instruction: string;
  text: string;
  // A transcript: commands in it are words the user said. When the instruction keeps the text's
  // words, a result that lost the transcript's opening carried such a command out instead.
  dictation: false | { instructionKeepsWords: boolean };
  budgetMs: number;
  signal: AbortSignal;
};

/** One free-form step on the loaded model, such as a meeting summary step. */
export type GenerateRequest = {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  /** Constrains the output to JSON of this shape. */
  jsonSchema?: GbnfJsonObjectSchema | undefined;
  budgetMs: number;
  signal: AbortSignal;
};

export type GenerateResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; failure: { kind: "tooLong" } | { kind: "timedOut" } };

export type TransformEngine = {
  load(): Promise<void>;
  // One run at a time, transforms and generate steps alike. Expected failures resolve as data;
  // aborting rejects with the signal's reason, and a broken model rejects with its error.
  transform(request: TransformRequest): Promise<TransformResult>;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  dispose(): Promise<void>;
};

const TIMED_OUT = { ok: false, failure: { kind: "timedOut" } } as const;

export function createTransformEngine({ modelPath }: { modelPath: string }): TransformEngine {
  const { load, serialize, withdrawal, dispose } = llamaHost(
    () =>
      openLlama({ modelPath, contextSize: TRANSFORM_MODEL.contextSize }, (llamaCpp, context) => ({
        session: new llamaCpp.LlamaChatSession({
          contextSequence: context.getSequence(),
          // Thinking off, as #311 measured it.
          chatWrapper: new llamaCpp.Gemma4ChatWrapper({ reasoning: false }),
          systemPrompt: SYSTEM_PROMPT,
        }),
      })),
    "Transform model disposed",
  );

  async function attempt(
    request: TransformRequest,
    deadline: AbortSignal,
  ): Promise<TransformResult> {
    const withdraw = withdrawal(request.signal);
    withdraw.throwIfAborted();
    const { model, session } = await load();
    withdraw.throwIfAborted();
    if (deadline.aborted) return TIMED_OUT;

    // A fresh chat on the one sequence: a new sequence per run fails with "No sequences left".
    await session.sequence.clearHistory();
    session.resetChatHistory();
    const user = userMessage({ ...request, dictation: request.dictation !== false });
    const plan = budget(
      {
        words: countWords(request.text),
        textTokens: model.tokenize(request.text).length,
        promptTokens: promptTokens(session.chatWrapper, model, SYSTEM_PROMPT, user),
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

  async function generateStep(
    request: GenerateRequest,
    deadline: AbortSignal,
  ): Promise<GenerateResult> {
    const withdraw = withdrawal(request.signal);
    withdraw.throwIfAborted();
    const { llama, model, session } = await load();
    withdraw.throwIfAborted();
    if (deadline.aborted) return TIMED_OUT;

    await session.sequence.clearHistory();
    session.setChatHistory([{ type: "system", text: request.system }]);
    const prompt = promptTokens(session.chatWrapper, model, request.system, request.user);
    if (prompt + request.maxTokens > TRANSFORM_MODEL.contextSize) {
      return { ok: false, failure: { kind: "tooLong" } };
    }
    const grammar = request.jsonSchema
      ? await llama.createGrammarForJsonSchema(request.jsonSchema)
      : undefined;
    try {
      const output = await session.promptWithMeta(request.user, {
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        ...(grammar && { grammar }),
        signal: AbortSignal.any([withdraw, deadline]),
      });
      withdraw.throwIfAborted();
      return { ok: true, text: output.responseText, truncated: output.stopReason === "maxTokens" };
    } catch (error) {
      withdraw.throwIfAborted();
      if (deadline.aborted) return TIMED_OUT;
      throw error;
    }
  }

  function withBudget<R, T extends { budgetMs: number }>(
    request: T,
    run: (request: T, deadline: AbortSignal) => Promise<R>,
  ): Promise<R> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), request.budgetMs);
    return serialize(() => run(request, deadline.signal)).finally(() => clearTimeout(timer));
  }

  return {
    load: async () => {
      await load();
    },
    transform: (request) => withBudget(request, attempt),
    generate: (request) => withBudget(request, generateStep),
    dispose,
  };
}

function promptTokens(
  chatWrapper: ChatWrapper,
  model: LlamaModel,
  system: string,
  user: string,
): number {
  const { contextText } = chatWrapper.generateContextState({
    chatHistory: [
      { type: "system", text: system },
      { type: "user", text: user },
      { type: "model", response: [] },
    ],
  });
  return contextText.tokenize(model.tokenizer).length;
}

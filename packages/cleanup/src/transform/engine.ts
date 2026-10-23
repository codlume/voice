import type { ChatWrapper, LlamaModel } from "node-llama-cpp";

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

export type TransformEngine = {
  load(): Promise<void>;
  // One run at a time. Expected failures resolve as data; aborting rejects with the signal's
  // reason, and a broken model rejects with its error.
  transform(request: TransformRequest): Promise<TransformResult>;
  dispose(): Promise<void>;
};

const TIMED_OUT: TransformResult = { ok: false, failure: { kind: "timedOut" } };

export function createTransformEngine({ modelPath }: { modelPath: string }): TransformEngine {
  const { load, serialize, withdrawal, dispose } = llamaHost(
    () =>
      openLlama(
        {
          modelPath,
          contextSize: TRANSFORM_MODEL.contextSize,
          gpuLayers: TRANSFORM_MODEL.gpuLayers,
        },
        (llamaCpp, context) => ({
          session: new llamaCpp.LlamaChatSession({
            contextSequence: context.getSequence(),
            // Thinking off, as #311 measured it.
            chatWrapper: new llamaCpp.Gemma4ChatWrapper({ reasoning: false }),
            systemPrompt: SYSTEM_PROMPT,
          }),
        }),
      ),
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
    dispose,
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

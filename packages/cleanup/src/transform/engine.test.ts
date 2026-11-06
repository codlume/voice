import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { createTransformEngine, type GenerateRequest, type TransformRequest } from "./engine.ts";

const native = vi.hoisted(() => ({
  prompts: [] as string[],
  events: [] as string[],
  pending: new Map<string, (text: string) => void>(),
}));

vi.mock("node-llama-cpp", () => {
  const sequence = {
    clearHistory: async () => {},
    evaluateWithoutGeneratingNewTokens: async () => {},
  };
  const model = {
    tokenizer: {},
    tokenize: (text: string) => [...text],
    createContext: async () => ({ getSequence: () => sequence }),
    dispose: async () => {},
  };
  return {
    getLlama: async () => ({
      loadModel: async () => model,
      dispose: async () => {},
      createGrammarForJsonSchema: async () => ({}),
    }),
    Gemma4ChatWrapper: class {
      generateContextState({ chatHistory }: { chatHistory: { text?: string }[] }) {
        const text = chatHistory.map((message) => message.text ?? "").join("\n");
        return { contextText: { tokenize: () => [...text] } };
      }
    },
    LlamaChatSession: class {
      sequence: typeof sequence;
      chatWrapper: unknown;
      constructor({
        contextSequence,
        chatWrapper,
      }: {
        contextSequence: typeof sequence;
        chatWrapper: unknown;
      }) {
        this.sequence = contextSequence;
        this.chatWrapper = chatWrapper;
      }
      resetChatHistory() {}
      setChatHistory() {}
      promptWithMeta(user: string, { signal }: { signal: AbortSignal }) {
        native.prompts.push(user);
        return new Promise<{ responseText: string; stopReason: string }>((resolve, reject) => {
          native.pending.set(user, (text) => {
            native.pending.delete(user);
            native.events.push(`done ${user}`);
            resolve({ responseText: text, stopReason: "eogToken" });
          });
          signal.addEventListener(
            "abort",
            () => {
              native.pending.delete(user);
              native.events.push(`stopped ${user}`);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      }
    },
  };
});

const step = (user: string, signal = new AbortController().signal): GenerateRequest => ({
  system: "Summarize the meeting.",
  user,
  maxTokens: 64,
  temperature: 0,
  budgetMs: 60_000,
  signal,
});

const transform = (text: string, signal = new AbortController().signal): TransformRequest => ({
  instruction: "Polish this text.",
  text,
  dictation: false,
  budgetMs: 60_000,
  signal,
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function running(text: string): Promise<string> {
  for (let tries = 0; tries < 50; tries++) {
    const prompt = [...native.pending.keys()].find((key) => key.includes(text));
    if (prompt) return prompt;
    await tick();
  }
  throw new Error(`the model never started on ${text}`);
}

const finish = (prompt: string, text: string) => native.pending.get(prompt)!(text);

const settledNow = (promise: Promise<unknown>) =>
  Promise.race([
    promise.then(
      () => "resolved",
      (error: unknown) => error,
    ),
    tick().then(() => "still queued"),
  ]);

const reason = new Error("meeting B deleted");

beforeEach(() => {
  native.prompts = [];
  native.events = [];
  native.pending.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => vi.useRealTimers());

test("a step aborted while queued behind another rejects at once, and the running step still finishes", async () => {
  const engine = createTransformEngine({ modelPath: "/models/transform.gguf" });
  const a = engine.generate(step("meeting A"));
  await running("meeting A");
  const abortB = new AbortController();
  const b = engine.generate(step("meeting B", abortB.signal));
  abortB.abort(reason);

  expect(await settledNow(b)).toBe(reason);
  expect(native.pending.has("meeting A")).toBe(true);
  expect(vi.getTimerCount()).toBe(1);

  finish("meeting A", "A was about pricing.");
  await expect(a).resolves.toEqual({ ok: true, text: "A was about pricing.", truncated: false });
  expect(vi.getTimerCount()).toBe(0);
});

test("the abandoned step does no model work when its turn comes, and the step after it runs", async () => {
  const engine = createTransformEngine({ modelPath: "/models/transform.gguf" });
  const a = engine.generate(step("meeting A"));
  await running("meeting A");
  const abortB = new AbortController();
  const b = engine.generate(step("meeting B", abortB.signal));
  const c = engine.generate(step("meeting C"));
  abortB.abort(reason);
  await expect(b).rejects.toBe(reason);

  finish("meeting A", "A was about pricing.");
  await a;
  finish(await running("meeting C"), "C was about hiring.");

  await expect(c).resolves.toEqual({ ok: true, text: "C was about hiring.", truncated: false });
  expect(native.prompts).toEqual(["meeting A", "meeting C"]);
  expect(native.events).toEqual(["done meeting A", "done meeting C"]);
});

test("a step aborted once it runs stops the model and rejects with the reason", async () => {
  const engine = createTransformEngine({ modelPath: "/models/transform.gguf" });
  const abortA = new AbortController();
  const a = engine.generate(step("meeting A", abortA.signal));
  await running("meeting A");
  abortA.abort(reason);

  await expect(a).rejects.toBe(reason);
  expect(native.events).toEqual(["stopped meeting A"]);
  expect(vi.getTimerCount()).toBe(0);
  const b = engine.generate(step("meeting B"));
  finish(await running("meeting B"), "B was about hiring.");
  await expect(b).resolves.toEqual({ ok: true, text: "B was about hiring.", truncated: false });
});

test("a step already aborted before the call rejects without reaching the model", async () => {
  const engine = createTransformEngine({ modelPath: "/models/transform.gguf" });

  await expect(engine.generate(step("meeting A", AbortSignal.abort(reason)))).rejects.toBe(reason);
  expect(native.prompts).toEqual([]);
});

test("a Transform already aborted before the call rejects without waiting for the one running", async () => {
  const engine = createTransformEngine({ modelPath: "/models/transform.gguf" });
  const first = engine.transform(transform("first draft"));
  const prompt = await running("first draft");
  const second = engine.transform(transform("second draft", AbortSignal.abort(reason)));

  expect(await settledNow(second)).toBe(reason);
  expect(native.pending.has(prompt)).toBe(true);

  finish(prompt, "First draft.");
  await expect(first).resolves.toEqual({ ok: true, text: "First draft." });
  expect(native.prompts).toEqual([prompt]);
});

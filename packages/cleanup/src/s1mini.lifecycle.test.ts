import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { chunkTranscript } from "./chunk.ts";
import type { S1Control } from "./prompt.ts";
import { CHUNK_TOKENS, createS1Mini, type CleanResult } from "./s1mini.ts";
import type { CleanupStyle } from "./style.ts";

type Reply = { response: string; stopReason?: string };

const native = vi.hoisted(() => ({
  getLlamaCalls: 0,
  failNextLoad: false,
  delayMs: (_raw: string): number => 0,
  active: 0,
  maxActive: 0,
  events: [] as string[],
  controls: [] as string[],
  reply: (raw: string): Reply => ({ response: ` ${raw.toUpperCase()} ` }),
}));

vi.mock("node-llama-cpp", () => {
  const model = {
    tokenize: (text: string) => [...text],
    createContext: async () => ({ getSequence: () => ({}) }),
    dispose: async () => void native.events.push("model.dispose"),
  };
  return {
    getLlama: async () => {
      native.getLlamaCalls++;
      return {
        loadModel: async () => {
          if (!native.failNextLoad) return model;
          native.failNextLoad = false;
          throw new Error("model file unreadable");
        },
        dispose: async () => void native.events.push("llama.dispose"),
      };
    },
    LlamaCompletion: class {
      async generateCompletionWithMeta(tokens: string[], { signal }: { signal?: AbortSignal }) {
        const prompt = tokens.join("");
        const raw = /\]\n([\s\S]*)<\|im_end\|>\n<\|im_start\|>assistant/.exec(prompt)![1]!;
        native.controls.push(/\[Styling.*\]/.exec(prompt)![0]);
        native.active++;
        native.maxActive = Math.max(native.maxActive, native.active);
        native.events.push(`generate ${raw.slice(0, 12)}`);
        try {
          await new Promise<void>((resolve, reject) => {
            const delay = native.delayMs(raw);
            const finish = delay === Infinity ? null : setTimeout(resolve, delay);
            signal?.addEventListener(
              "abort",
              () => {
                if (finish) clearTimeout(finish);
                reject(signal.reason);
              },
              { once: true },
            );
          });
        } catch (error) {
          native.active--;
          native.events.push("aborted");
          throw error;
        }
        native.active--;
        native.events.push("done");
        const { response, stopReason = "eogToken" } = native.reply(raw);
        return { response, metadata: { stopReason } };
      }
    },
  };
});

const style: CleanupStyle = { style: "formal", layout: "general" };
const control: S1Control = { styling: "semi-formal", context: "general" };
const timed = { queueMs: expect.any(Number), generateMs: expect.any(Number) };
const whole = (text: string): CleanResult => ({ text, chunks: 1, cleaned: 1, ...timed });
const generations = () => native.events.filter((e) => e.startsWith("generate"));

const line = (i: number) =>
  `item ${String(i).padStart(2, "0")} is that we should ship the beta on october twelfth and the stable release after that.`;
const lineCount = Math.floor((2.4 * CHUNK_TOKENS) / (line(0).length + 1));
const threeChunkRaw = Array.from({ length: lineCount }, (_, i) => line(i)).join(" ");
const [first, second, third] = chunkTranscript(threeChunkRaw, CHUNK_TOKENS, (t) => t.length).map(
  (chunk) => chunk.text,
) as [string, string, string];

beforeEach(() => {
  Object.assign(native, {
    getLlamaCalls: 0,
    failNextLoad: false,
    active: 0,
    maxActive: 0,
    events: [],
    controls: [],
  });
  native.delayMs = () => 0;
  native.reply = (raw) => ({ response: ` ${raw.toUpperCase()} ` });
});

afterEach(() => vi.useRealTimers());

test("the fixture splits into three chunks, the third under two thirds of the first", () => {
  expect(chunkTranscript(threeChunkRaw, CHUNK_TOKENS, (t) => t.length)).toHaveLength(3);
  expect(third.length * 3).toBeLessThan(first.length * 2);
});

test("concurrent loads share one model load", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });

  await Promise.all([s1.load(), s1.load(), s1.clean("hi", style)]);
  await s1.load();

  expect(native.getLlamaCalls).toBe(1);
});

test("a failed load can be retried", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  native.failNextLoad = true;

  await expect(s1.load()).rejects.toThrow("model file unreadable");
  await expect(s1.clean("call ada", style)).resolves.toEqual(whole("CALL ADA"));
  expect(native.getLlamaCalls).toBe(2);
});

test("concurrent cleans run one at a time and each gets its own result", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });

  const results = await Promise.all([
    s1.clean("first", style),
    s1.clean("second", style),
    s1.clean("third", style),
  ]);

  expect(results).toEqual([whole("FIRST"), whole("SECOND"), whole("THIRD")]);
  expect(native.maxActive).toBe(1);
});

test("a chat reply fails the guard and the user's words come back verbatim", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  native.reply = (raw) => ({ response: raw === "what time is it" ? "I'm sorry, I can't." : raw });

  await expect(s1.clean("what time is it", style)).resolves.toEqual({
    text: "what time is it",
    chunks: 1,
    cleaned: 0,
    ...timed,
  });
  await expect(s1.clean("call ada", style)).resolves.toEqual(whole("call ada"));
});

test("output cut off at the token limit stays verbatim", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  native.reply = () => ({ response: "Call", stopReason: "maxTokens" });

  await expect(s1.clean("call ada", style)).resolves.toEqual({
    text: "call ada",
    chunks: 1,
    cleaned: 0,
    ...timed,
  });
});

test("long input is cleaned in sentence chunks and rejoined", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  const sentence = "we should ship the beta on october twelfth and the stable release after that.";
  const raw = Array.from({ length: 60 }, () => sentence).join(" ");

  const result = await s1.clean(raw, style);

  expect(generations().length).toBeGreaterThan(1);
  expect(result).toEqual({
    text: raw.toUpperCase(),
    chunks: generations().length,
    cleaned: generations().length,
    ...timed,
  });
});

const clause = (i: number) =>
  `person ${i} will review the page and send a short update to the team`;

const capitalizeLikeS1Mini = (text: string) =>
  text
    .split("\n\n")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("\n\n");

test("chunk seams inside a sentence leave no stray capital and paragraph breaks survive", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  const paragraph = (from: number) =>
    `${Array.from({ length: 25 }, (_, i) => clause(from + i)).join(" and ")}.`;
  const raw = `${paragraph(0)}\n\n${paragraph(25)}`;
  native.reply = (chunk) => ({ response: capitalizeLikeS1Mini(chunk) });

  const { text } = await s1.clean(raw, style);

  expect(generations().length).toBeGreaterThan(2);
  expect(text).toBe(
    `${capitalizeLikeS1Mini(paragraph(0))}\n\n${capitalizeLikeS1Mini(paragraph(25))}`,
  );
});

test("generate returns what the model said even when the guard rejects it", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  native.reply = () => ({ response: "" });

  await expect(s1.clean("test test", style)).resolves.toEqual({
    text: "test test",
    chunks: 1,
    cleaned: 0,
    ...timed,
  });
  await expect(s1.generate("test test", control)).resolves.toEqual([
    { chunk: "test test", output: "", truncated: false },
  ]);
});

test("a chunk that comes back empty stays verbatim while the others are cleaned", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  native.reply = (chunk) => ({ response: chunk === second ? "" : ` ${chunk.toUpperCase()} ` });

  await expect(s1.clean(threeChunkRaw, style)).resolves.toEqual({
    text: `${first.toUpperCase()} ${second} ${third.toUpperCase()}`,
    chunks: 3,
    cleaned: 2,
    ...timed,
  });
  expect(generations()).toHaveLength(3);
});

test("the budget ends the clean with the finished chunks cleaned and the rest verbatim, in order", async () => {
  vi.useFakeTimers();
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  native.delayMs = (raw) => (raw === second ? Infinity : 0);
  let result: CleanResult | undefined;

  const clean = s1.clean(threeChunkRaw, style, { budgetMs: 5000 }).then((r) => (result = r));
  await vi.advanceTimersByTimeAsync(4999);
  expect(result).toBeUndefined();
  expect(native.events).toEqual([
    `generate ${first.slice(0, 12)}`,
    "done",
    `generate ${second.slice(0, 12)}`,
  ]);
  await vi.advanceTimersByTimeAsync(1);
  await clean;

  expect(result).toEqual({
    text: `${first.toUpperCase()} ${second} ${third}`,
    chunks: 3,
    cleaned: 1,
    ...timed,
  });
  expect(native.events.at(-1)).toBe("aborted");
  expect(generations()).toHaveLength(2);
});

test("under Casual, a budget cut keeps the last cleaned chunk's period because raw words follow it", async () => {
  vi.useFakeTimers();
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  const raw = Array.from({ length: lineCount }, (_, i) => line(i)).join("\n");
  const [cleaned, cut] = chunkTranscript(raw, CHUNK_TOKENS, (t) => t.length);
  native.delayMs = (chunk) => (chunk === cut!.text ? Infinity : 0);

  const clean = s1.clean(raw, { style: "casual", layout: "general" }, { budgetMs: 5000 });
  await vi.advanceTimersByTimeAsync(5000);

  await expect(clean).resolves.toMatchObject({
    text: cleaned!.text.toUpperCase() + raw.slice(cleaned!.end),
    cleaned: 1,
  });
});

test("the budget counts from the call, so a clean queued behind a long one gets less", async () => {
  vi.useFakeTimers();
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  native.delayMs = (raw) => (raw === "slow" ? 3000 : 0);

  const slow = s1.clean("slow", style);
  const queued = s1.clean("call ada", style, { budgetMs: 2000 });
  await vi.advanceTimersByTimeAsync(3000);

  await expect(slow).resolves.toEqual(whole("SLOW"));
  await expect(queued).resolves.toEqual({ text: "call ada", chunks: 1, cleaned: 0, ...timed });
  expect(generations()).toEqual(["generate slow"]);
});

test("a clean reports the wait behind the busy loop's generation apart from its own", async () => {
  vi.useFakeTimers();
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  await s1.load();
  native.delayMs = (raw) => (raw === "ok" ? 300 : 40);

  s1.keepGpuBusy(1000);
  await vi.advanceTimersByTimeAsync(10);
  const clean = s1.clean("call ada", style);
  await vi.advanceTimersByTimeAsync(1000);

  await expect(clean).resolves.toEqual({
    text: "CALL ADA",
    chunks: 1,
    cleaned: 1,
    queueMs: 290,
    generateMs: 40,
  });
  expect(generations()).toEqual(["generate ok", "generate call ada"]);
});

test("a learned rate skips a chunk the budget cannot fit instead of starting it", async () => {
  vi.useFakeTimers();
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  native.delayMs = () => 3000;

  const clean = s1.clean(threeChunkRaw, style, { budgetMs: 5000 });
  await vi.advanceTimersByTimeAsync(3000);

  await expect(clean).resolves.toEqual({
    text: `${first.toUpperCase()} ${second} ${third}`,
    chunks: 3,
    cleaned: 1,
    ...timed,
  });
  expect(native.events).toEqual([`generate ${first.slice(0, 12)}`, "done"]);
});

test("a short slow first chunk teaches no rate, so the long chunks after it still run", async () => {
  vi.useFakeTimers();
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  const warmUp = "um so this is a warm up";
  native.delayMs = (raw) => (raw === warmUp ? 3000 : 0);

  const clean = s1.clean(`${warmUp}\n${threeChunkRaw}`, style, { budgetMs: 5000 });
  await vi.advanceTimersByTimeAsync(3010);

  await expect(clean).resolves.toEqual({
    text: `${warmUp.toUpperCase()}\n${threeChunkRaw.toUpperCase()}`,
    chunks: 4,
    cleaned: 4,
    ...timed,
  });
});

test("one slow clean does not keep a later clean from being attempted once the model is fast again", async () => {
  vi.useFakeTimers();
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  const slowRaw = Array.from({ length: 3 }, () => line(99)).join(" ");
  native.delayMs = (raw) => (raw === slowRaw ? 4000 : 0);

  const slow = s1.clean(slowRaw, style);
  await vi.advanceTimersByTimeAsync(4000);
  await expect(slow).resolves.toMatchObject({ cleaned: 1 });
  const clean = s1.clean(threeChunkRaw, style, { budgetMs: 5000 });
  await vi.advanceTimersByTimeAsync(10);

  await expect(clean).resolves.toEqual({
    text: threeChunkRaw.toUpperCase(),
    chunks: 3,
    cleaned: 3,
    ...timed,
  });
});

test("an aborted clean stops the generation and rejects with the reason, and the next clean runs", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  native.delayMs = () => Infinity;
  const controller = new AbortController();

  const aborted = s1.clean("call ada", style, { budgetMs: 60_000, signal: controller.signal });
  await expect.poll(() => native.events).toContain("generate call ada");
  controller.abort(new Error("over budget"));

  await expect(aborted).rejects.toThrow("over budget");
  expect(native.events).toEqual(["generate call ada", "aborted"]);
  native.delayMs = () => 0;
  await expect(s1.clean("second", style)).resolves.toEqual(whole("SECOND"));
});

test("dispose aborts the running and queued cleans instead of waiting, then frees the model", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  native.delayMs = () => Infinity;

  const running = s1.clean("call ada", style, { budgetMs: 60_000 });
  const queued = s1.clean("second", style);
  await expect.poll(() => native.events).toContain("generate call ada");
  const disposing = s1.dispose();

  await expect(running).rejects.toThrow("disposed");
  await expect(queued).rejects.toThrow("disposed");
  await disposing;
  expect(native.events).toEqual(["generate call ada", "aborted", "model.dispose", "llama.dispose"]);
});

test("keepGpuBusy generates until a clean arrives, which follows the iteration in flight", async () => {
  vi.useFakeTimers();
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  await s1.load();
  native.delayMs = () => 10;

  s1.keepGpuBusy(1000);
  await vi.advanceTimersByTimeAsync(75);
  expect(native.active).toBe(1);
  const clean = s1.clean("call ada", style);
  await vi.advanceTimersByTimeAsync(20);

  await expect(clean).resolves.toEqual(whole("CALL ADA"));
  expect(native.events.slice(-3)).toEqual(["done", "generate call ada", "done"]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(generations()).toEqual([...Array<string>(3).fill("generate ok"), "generate call ada"]);
  expect(native.maxActive).toBe(1);
});

test("keepGpuBusy stops at its deadline, and a second call moves the deadline instead of starting another loop", async () => {
  vi.useFakeTimers();
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  await s1.load();
  native.delayMs = () => 10;

  s1.keepGpuBusy(50);
  await vi.advanceTimersByTimeAsync(40);
  s1.keepGpuBusy(50);
  await vi.advanceTimersByTimeAsync(200);

  expect(generations()).toEqual(Array<string>(3).fill("generate ok"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(generations()).toHaveLength(3);
  expect(native.maxActive).toBe(1);
});

test("keepGpuBusy(0) stops the loop", async () => {
  vi.useFakeTimers();
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  await s1.load();
  native.delayMs = () => 10;

  s1.keepGpuBusy(1000);
  await vi.advanceTimersByTimeAsync(40);
  s1.keepGpuBusy(0);
  await vi.advanceTimersByTimeAsync(1000);

  expect(generations()).toEqual(Array<string>(2).fill("generate ok"));
});

test("generate ends the busy loop", async () => {
  vi.useFakeTimers();
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  await s1.load();
  native.delayMs = () => 10;

  s1.keepGpuBusy(1000);
  await vi.advanceTimersByTimeAsync(40);
  const generating = s1.generate("call ada", control);
  await vi.advanceTimersByTimeAsync(1000);

  await expect(generating).resolves.toHaveLength(1);
  expect(generations()).toEqual(["generate ok", "generate ok", "generate call ada"]);
});

test("a failed busy generation ends the loop instead of retrying", async () => {
  vi.useFakeTimers();
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  await s1.load();
  native.delayMs = () => {
    throw new Error("context lost");
  };

  s1.keepGpuBusy(1000);
  await vi.advanceTimersByTimeAsync(1000);

  expect(native.events).toEqual(["generate ok", "aborted"]);
});

test("keepGpuBusy before load does nothing, now or once the model loads", async () => {
  vi.useFakeTimers();
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });

  s1.keepGpuBusy(1000);
  await vi.advanceTimersByTimeAsync(100);
  expect(native.getLlamaCalls).toBe(0);
  await s1.load();
  await vi.advanceTimersByTimeAsync(1000);

  expect(native.events).toEqual([]);
});

test("dispose stops the busy loop for good, even when the model loads again", async () => {
  vi.useFakeTimers();
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  await s1.load();
  native.delayMs = () => 10;

  s1.keepGpuBusy(60_000);
  await vi.advanceTimersByTimeAsync(5);
  await s1.dispose();
  await s1.load();
  await vi.advanceTimersByTimeAsync(1000);

  expect(native.events).toEqual(["generate ok", "aborted", "model.dispose", "llama.dispose"]);
});

test("the model reloads after dispose", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  await s1.load();
  await s1.dispose();

  await expect(s1.clean("call ada", style)).resolves.toEqual(whole("CALL ADA"));
  expect(native.getLlamaCalls).toBe(2);
});

const capitalized = [first, second, third].map(capitalizeLikeS1Mini).join(" ");

test.each([
  ["formal", capitalized],
  ["casual", capitalized.slice(0, -1)],
  ["veryCasual", threeChunkRaw.slice(0, -1)],
] as const)(
  "%s finishes the accepted chunks of a long dictation",
  async (writingStyle, expected) => {
    const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
    native.reply = (chunk) => ({ response: capitalizeLikeS1Mini(chunk) });

    const { text } = await s1.clean(threeChunkRaw, { style: writingStyle, layout: "general" });

    expect(text).toBe(expected);
  },
);

test.each(["casual", "veryCasual"] as const)(
  "%s leaves a rejected last chunk as the user's exact words, period included",
  async (writingStyle) => {
    const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
    const rejected = third.replace("ship the beta", "ship the GitHub API");
    const raw = `${first} ${second} ${rejected}`;
    expect(chunkTranscript(raw, CHUNK_TOKENS, (t) => t.length).at(-1)?.text).toBe(rejected);
    native.reply = (chunk) => ({ response: chunk === rejected ? "" : capitalizeLikeS1Mini(chunk) });

    const { text } = await s1.clean(raw, { style: writingStyle, layout: "general" });

    const cleaned = [first, second].map(capitalizeLikeS1Mini).join(" ");
    expect(text).toBe(
      `${writingStyle === "veryCasual" ? cleaned.toLowerCase() : cleaned} ${rejected}`,
    );
  },
);

test("a last chunk of only fillers that cleans to nothing still lets Casual drop the period", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  native.reply = (chunk) => ({ response: chunk === "um uh" ? "" : capitalizeLikeS1Mini(chunk) });

  await expect(
    s1.clean("let's do that.\num uh", { style: "casual", layout: "general" }),
  ).resolves.toEqual({ text: "Let's do that", chunks: 2, cleaned: 2, ...timed });
});

test("an email dictation that needs two chunks is cleaned in the general layout", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });

  await s1.clean(threeChunkRaw, { style: "formal", layout: "email" });
  await s1.clean("hi maria thanks for sending the deck i will send my notes tomorrow", {
    style: "formal",
    layout: "email",
  });

  expect(native.controls).toEqual([
    "[Styling: semi-formal] [Structure: prose] [Context: general]",
    "[Styling: semi-formal] [Structure: prose] [Context: general]",
    "[Styling: semi-formal] [Structure: prose] [Context: general]",
    "[Styling: semi-formal] [Structure: prose] [Context: email]",
  ]);
});

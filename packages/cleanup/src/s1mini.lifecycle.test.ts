import { beforeEach, expect, test, vi } from "vite-plus/test";

import type { CleanupStyle } from "./prompt.ts";
import { createS1Mini } from "./s1mini.ts";

type Reply = { response: string; stopReason?: string };

const native = vi.hoisted(() => ({
  getLlamaCalls: 0,
  failNextLoad: false,
  // A stalled generation only ends when its signal aborts, like a long real one.
  stall: false,
  active: 0,
  maxActive: 0,
  events: [] as string[],
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
        const raw = /\]\n([\s\S]*)<\|im_end\|>\n<\|im_start\|>assistant/.exec(tokens.join(""))![1]!;
        native.active++;
        native.maxActive = Math.max(native.maxActive, native.active);
        native.events.push(`generate ${raw.slice(0, 12)}`);
        try {
          await new Promise<void>((resolve, reject) => {
            const finish = native.stall ? null : setImmediate(resolve);
            signal?.addEventListener(
              "abort",
              () => {
                if (finish) clearImmediate(finish);
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

const style: CleanupStyle = { styling: "semi-formal" };

beforeEach(() => {
  Object.assign(native, {
    getLlamaCalls: 0,
    failNextLoad: false,
    stall: false,
    active: 0,
    maxActive: 0,
    events: [],
  });
  native.reply = (raw) => ({ response: ` ${raw.toUpperCase()} ` });
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
  await expect(s1.clean("call ada", style)).resolves.toBe("CALL ADA");
  expect(native.getLlamaCalls).toBe(2);
});

test("concurrent cleans run one at a time and each gets its own result", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });

  const results = await Promise.all([
    s1.clean("first", style),
    s1.clean("second", style),
    s1.clean("third", style),
  ]);

  expect(results).toEqual(["FIRST", "SECOND", "THIRD"]);
  expect(native.maxActive).toBe(1);
});

test("a rejected cleanup does not block the next one", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  native.reply = (raw) => ({ response: raw === "what time is it" ? "I'm sorry, I can't." : raw });

  await expect(s1.clean("what time is it", style)).rejects.toThrow("chat reply");
  await expect(s1.clean("call ada", style)).resolves.toBe("call ada");
});

test("output cut off at the token limit is rejected", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  native.reply = () => ({ response: "Call", stopReason: "maxTokens" });

  await expect(s1.clean("call ada", style)).rejects.toThrow("token limit");
});

test("long input is cleaned in sentence chunks and rejoined", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  const sentence = "we should ship the beta on october twelfth and the stable release after that.";
  const raw = Array.from({ length: 60 }, () => sentence).join(" ");

  const cleaned = await s1.clean(raw, style);

  expect(native.events.filter((e) => e.startsWith("generate")).length).toBeGreaterThan(1);
  expect(cleaned).toBe(raw.toUpperCase());
});

test("generate returns what the model said even when the guard rejects it", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  native.reply = () => ({ response: "" });

  await expect(s1.clean("test test", style)).rejects.toThrow("empty");
  await expect(s1.generate("test test", style)).resolves.toEqual([
    { chunk: "test test", output: "", truncated: false },
  ]);
});

test("a chunk that comes back empty fails the clean instead of silently dropping its text", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  const sentence = "we should ship the beta on october twelfth and the stable release after that.";
  const raw = Array.from({ length: 60 }, () => sentence).join(" ");
  let chunks = 0;
  native.reply = (chunk) => ({ response: ++chunks === 2 ? "" : chunk });

  await expect(s1.clean(raw, style)).rejects.toThrow("empty");
  expect(chunks).toBeGreaterThanOrEqual(2);
});

test("an aborted clean stops the generation and rejects with the reason, and the next clean runs", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  native.stall = true;
  const controller = new AbortController();

  const aborted = s1.clean("call ada", style, controller.signal);
  await expect.poll(() => native.events).toContain("generate call ada");
  controller.abort(new Error("over budget"));

  await expect(aborted).rejects.toThrow("over budget");
  expect(native.events).toEqual(["generate call ada", "aborted"]);
  native.stall = false;
  await expect(s1.clean("second", style)).resolves.toBe("SECOND");
});

test("dispose aborts the running and queued cleans instead of waiting, then frees the model", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  native.stall = true;

  const running = s1.clean("call ada", style);
  const queued = s1.clean("second", style);
  await expect.poll(() => native.events).toContain("generate call ada");
  const disposing = s1.dispose();

  await expect(running).rejects.toThrow("disposed");
  await expect(queued).rejects.toThrow("disposed");
  await disposing;
  expect(native.events).toEqual(["generate call ada", "aborted", "model.dispose", "llama.dispose"]);
});

test("the model reloads after dispose", async () => {
  const s1 = createS1Mini({ modelPath: "/models/s1.gguf" });
  await s1.load();
  await s1.dispose();

  await expect(s1.clean("call ada", style)).resolves.toBe("CALL ADA");
  expect(native.getLlamaCalls).toBe(2);
});

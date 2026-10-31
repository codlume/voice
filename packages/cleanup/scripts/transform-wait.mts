// How long a dictation Transform waits while a meeting summary runs on the same model, and what
// the context size costs a Transform. Synthetic text only.
//
//   node packages/cleanup/scripts/transform-wait.mts wait [--fixture en-30] [--model <gguf>]
//   node packages/cleanup/scripts/transform-wait.mts context [--rounds 4] [--model <gguf>]
//
// wait: runs the fixture's summary twice, first with Transforms queued behind summary steps
// ("queued"), then with Transforms going first (`transformsFirst`, "first"). Transforms are asked
// for one after another at fixed times after the summary starts, as a user dictating would.
// Wait is a Transform's time minus its idle time.
// context: alternates an 8,192 and a 16,384-token engine, a few idle Transforms per round.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { createGemmaSummaryProvider, estimateTokens } from "../src/summary/gemma.ts";
import type { TranscriptLine } from "../src/summary/provider.ts";
import { createTransformEngine, type TransformEngine } from "../src/transform/engine.ts";
import { TRANSFORM_MODEL } from "../src/transform/model.ts";
import { transformsFirst } from "../src/transform/preempt.ts";

const FIXTURES = new URL("../../../test-fixtures/meetings/", import.meta.url).pathname;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: {
      type: "string",
      default: join(
        homedir(),
        "Library/Caches/Voice Development/test-models/gemma-4-E2B-it-Q4_K_M.gguf",
      ),
    },
    fixture: { type: "string", default: "en-30" },
    rounds: { type: "string", default: "4" },
    at: { type: "string", default: "1,8,20,35,55" },
  },
});

const DICTATION =
  "so um I wanted to follow up on the launch plan we talked about yesterday, I think we should move the beta to next tuesday because the payment flow still has that bug with the currency rounding and Ana said she can have the fix by monday, and then we can send the invite to the first fifty customers on wednesday";
const INSTRUCTION =
  "Polish this text. Make it more concise and easier to read: remove filler words, repetition and false starts, reword unclear sentences, and reorder sentences where that reads better. Add paragraph breaks or a list only where the text has separate points. Keep the author's tone and point of view, and keep every fact.";

const transformRequest = () => ({
  instruction: INSTRUCTION,
  text: DICTATION,
  dictation: { instructionKeepsWords: true },
  budgetMs: 600_000,
  signal: new AbortController().signal,
});

async function timed<T>(work: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await work();
  return { ms: performance.now() - start, value };
}

const median = (samples: number[]) => {
  const sorted = samples.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};
const s = (ms: number) => (ms / 1000).toFixed(2);

function readLines(fixture: string): TranscriptLine[] {
  return readFileSync(join(FIXTURES, `${fixture}.txt`), "utf8")
    .split("\n")
    .flatMap((line): TranscriptLine[] => {
      const match = line.match(/^\[(\d+):(\d+):(\d+)\]\s*([^:]+):\s*(.*)$/);
      if (!match) return [];
      const [, h, m, sec, label, text] = match;
      const startMs = ((Number(h) * 60 + Number(m)) * 60 + Number(sec)) * 1000;
      const speaker = label === "You" ? "you" : label!.trim().replace(/^Speaker (\d+)$/, "s$1");
      return [{ speaker, startMs, text: text!.trim() }];
    });
}

async function idleTransforms(engine: TransformEngine, count: number): Promise<number[]> {
  const times: number[] = [];
  for (let index = 0; index < count; index++) {
    const { ms } = await timed(() => engine.transform(transformRequest()));
    times.push(ms);
  }
  return times;
}

async function waitRun(engine: TransformEngine, mode: "queued" | "first", idleMs: number) {
  const model =
    mode === "first"
      ? transformsFirst(engine.transform, engine.generate)
      : { transform: engine.transform, generate: engine.generate };
  const lines = readLines(values.fixture);
  const speakers = [...new Set(lines.map(({ speaker }) => speaker))].map((id) => ({
    id,
    label: id === "you" ? "You" : id.replace(/^s(\d+)$/, "Speaker $1"),
  }));
  const provider = createGemmaSummaryProvider({
    tokens: estimateTokens,
    generate: (step) => model.generate({ ...step, budgetMs: 600_000 }),
  });
  let running = true;
  const started = performance.now();
  const summary = timed(() =>
    provider.summarize({
      lines,
      speakers,
      notes: "",
      title: "generate",
      signal: new AbortController().signal,
    }),
  ).finally(() => (running = false));
  const waits: number[] = [];
  for (const at of values.at.split(",").map((seconds) => Number(seconds) * 1000)) {
    const due = started + at - performance.now();
    if (due > 0) await new Promise((resolve) => setTimeout(resolve, due));
    if (!running) break;
    const { ms } = await timed(() => model.transform(transformRequest()));
    waits.push(Math.max(0, ms - idleMs));
  }
  const done = await summary;
  if (!done.value.ok) throw new Error(`summary failed: ${done.value.failure.kind}`);
  console.log(
    [
      `${mode.padEnd(6)} transforms ${waits.length}`,
      `wait max ${s(Math.max(...waits))} s`,
      `median ${s(median(waits))} s`,
      `waits ${waits.map(s).join(" ")}`,
      `summary ${s(done.ms)} s`,
    ].join("  "),
  );
}

const command = positionals[0];
if (command === "wait") {
  const engine = createTransformEngine({ modelPath: values.model });
  await engine.load();
  await idleTransforms(engine, 2);
  const idle = await idleTransforms(engine, 5);
  const idleMs = median(idle);
  console.log(`idle transform median ${s(idleMs)} s (${idle.map(s).join(" ")})`);
  await waitRun(engine, "queued", idleMs);
  await waitRun(engine, "first", idleMs);
  await engine.dispose();
} else if (command === "context") {
  const sizes = [8192, TRANSFORM_MODEL.contextSize];
  const times = new Map<number, number[]>(sizes.map((size) => [size, []]));
  for (let round = 0; round < Number(values.rounds); round++) {
    for (const contextSize of round % 2 === 0 ? sizes : sizes.toReversed()) {
      const engine = createTransformEngine({ modelPath: values.model, contextSize });
      await engine.load();
      await idleTransforms(engine, 1);
      const run = await idleTransforms(engine, 5);
      times.get(contextSize)!.push(...run);
      console.log(`round ${round + 1} ${contextSize}: ${run.map(s).join(" ")}`);
      await engine.dispose();
    }
  }
  for (const [size, run] of times) {
    console.log(
      `${size}: median ${s(median(run))} s, min ${s(Math.min(...run))} s, max ${s(Math.max(...run))} s, n ${run.length}`,
    );
  }
} else {
  throw new Error("usage: transform-wait.mts wait|context");
}

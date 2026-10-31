import { describe, expect, test } from "vite-plus/test";

import type { GenerateRequest, GenerateResult } from "../transform/engine.ts";
import {
  chunkLines,
  cleanTitle,
  createGemmaSummaryProvider,
  estimateTokens,
  PART_TOKENS,
  planParts,
  WHOLE_TOKENS,
  type GenerateStep,
} from "./gemma.ts";
import type { Speaker, SummaryRequest, TranscriptLine } from "./provider.ts";

type Step = Omit<GenerateRequest, "budgetMs">;

const isPart = (step: Step) => "topics" in (step.jsonSchema?.properties ?? {});

const speakers: Speaker[] = [
  { id: "you", label: "You" },
  { id: "Speaker 1", label: "Speaker 1" },
  { id: "Speaker 2", label: "Speaker 2" },
];

const sentence =
  "we agreed to ship the hotfix today and the release notes go out on friday after the review";

function transcript(lineCount: number, words = sentence): TranscriptLine[] {
  return Array.from({ length: lineCount }, (_, index) => ({
    speaker: index % 2 === 0 ? "you" : "Speaker 1",
    startMs: index * 5000,
    text: words,
  }));
}

const part = (fields: Partial<Record<string, unknown>> = {}) =>
  JSON.stringify({
    topics: ["The hotfix ships today."],
    decisions: [{ decision: "Ship the hotfix today.", status: "final" }],
    nextSteps: [
      { owner: "Speaker 1", task: "Write the release notes by Friday.", status: "agreed" },
    ],
    overview: "The hotfix ships today and Speaker 1 writes the release notes by Friday.",
    ...fields,
  });

const ok = (text: string, truncated = false): GenerateResult => ({ ok: true, text, truncated });

/** Answers by step kind, the way the engine would, and records every step. */
function fakeModel(answers: {
  part?: (step: Step, index: number) => GenerateResult;
  pair?: (step: Step) => GenerateResult;
  overview?: () => GenerateResult;
  title?: (attempt: number) => GenerateResult;
}) {
  const steps: Step[] = [];
  let parts = 0;
  let titles = 0;
  const generate: GenerateStep = async (step) => {
    steps.push(step);
    const properties = Object.keys(step.jsonSchema?.properties ?? {});
    if (properties.includes("topics")) return (answers.part ?? (() => ok(part())))(step, parts++);
    if (properties.includes("answer"))
      return (answers.pair ?? (() => ok('{"answer": "no"}')))(step);
    if (step.user.includes('<field name="title">')) {
      return (answers.title ?? (() => ok("title: Hotfix Release Plan")))(titles++);
    }
    return (answers.overview ?? (() => ok("The hotfix ships today.")))();
  };
  return { steps, generate };
}

const request = (overrides: Partial<SummaryRequest> = {}): SummaryRequest => ({
  lines: transcript(10),
  speakers,
  notes: "",
  title: "keep",
  signal: new AbortController().signal,
  ...overrides,
});

describe("summarize", () => {
  test("a short meeting is one JSON step whose owners are the transcript's own labels", async () => {
    const model = fakeModel({});
    const provider = createGemmaSummaryProvider({
      generate: model.generate,
      tokens: estimateTokens,
    });

    const result = await provider.summarize(request());

    expect(model.steps).toHaveLength(1);
    const schema = model.steps[0]!.jsonSchema as unknown as {
      properties: { nextSteps: { items: { properties: { owner: { enum: string[] } } } } };
    };
    // Speaker 2 never spoke, so no task can be given to them.
    expect(schema.properties.nextSteps.items.properties.owner.enum).toEqual([
      "You",
      "Speaker 1",
      "Unassigned",
    ]);
    expect(model.steps[0]!.user).toContain("You: we agreed to ship");
    expect(result).toEqual({
      ok: true,
      summary: {
        title: null,
        language: "en",
        overview: "The hotfix ships today and Speaker 1 writes the release notes by Friday.",
        decisions: ["Ship the hotfix today."],
        nextSteps: [{ owner: "Speaker 1", task: "Write the release notes by Friday." }],
      },
    });
  });

  test("only final decisions and agreed tasks count, and owners map back to speaker ids", async () => {
    const model = fakeModel({
      part: () =>
        ok(
          part({
            decisions: [
              { decision: "Launch on November 10.", status: "changed" },
              { decision: "Use contractors.", status: "rejected" },
              { decision: "Launch on November 17.", status: "final" },
            ],
            nextSteps: [
              { owner: "Speaker 1", task: "Write the listing copy.", status: "moved" },
              { owner: "You", task: "Write the listing copy and captions.", status: "agreed" },
              { owner: "Speaker 1", task: "Maybe look at Android.", status: "idea" },
              { owner: "Unassigned", task: "Book the venue for the party.", status: "agreed" },
              { owner: "Speaker 1", task: "Ship.", status: "agreed" },
            ],
          }),
        ),
    });
    const provider = createGemmaSummaryProvider({
      generate: model.generate,
      tokens: estimateTokens,
    });

    const result = await provider.summarize(request());

    expect(result.ok && result.summary.decisions).toEqual(["Launch on November 17."]);
    expect(result.ok && result.summary.nextSteps).toEqual([
      { owner: "you", task: "Write the listing copy and captions." },
      { owner: null, task: "Book the venue for the party." },
    ]);
  });

  test("a long meeting goes in parts, where a confirmed change or a repeat replaces the earlier item", async () => {
    const parts = [
      {
        decision: "Launch on Tuesday, November 10.",
        owner: "Speaker 1",
        task: "Call Brightline about the volume tier.",
      },
      {
        decision: "Launch moves to Tuesday, November 17.",
        owner: "You",
        task: "Take the Brightline volume tier call.",
      },
    ];
    const model = fakeModel({
      part: (_, index) => {
        const { decision, owner, task } = parts[Math.min(index, 1)]!;
        return ok(
          part({
            decisions: [{ decision, status: "final" }],
            nextSteps: [{ owner, task, status: "agreed" }],
            overview: undefined,
          }),
        );
      },
      pair: (step) => ok(step.user.includes("Launch") ? '{"answer": "yes"}' : '{"answer": "no"}'),
      overview: () => ok("  Launch is on November 17.  "),
    });
    const progress: number[] = [];
    const provider = createGemmaSummaryProvider({
      generate: model.generate,
      tokens: estimateTokens,
    });

    const result = await provider.summarize(
      request({
        lines: transcript(1200),
        title: "generate",
        onProgress: ({ done, total }) => progress.push(done / total),
      }),
    );

    const partSteps = model.steps.filter((step) => isPart(step));
    expect(partSteps.length).toBeGreaterThan(2);
    expect(partSteps[0]!.user).toContain(`part 1 of ${partSteps.length}`);
    // Only a single-part meeting asks for its overview in the extraction.
    expect(partSteps[0]!.jsonSchema?.properties).not.toHaveProperty("overview");
    expect(result).toMatchObject({
      ok: true,
      summary: {
        overview: "Launch is on November 17.",
        decisions: ["Launch moves to Tuesday, November 17."],
        // The later part repeats the task with a new owner, which takes it over.
        nextSteps: [{ owner: "you", task: "Take the Brightline volume tier call." }],
        title: "Hotfix Release Plan",
      },
    });
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual(progress.toSorted((a, b) => a - b));
  });

  test("a part that overflows the context hands its tail to the next part", async () => {
    let first = true;
    const model = fakeModel({
      part: () => {
        if (!first) return ok(part());
        first = false;
        return { ok: false, failure: { kind: "tooLong" } };
      },
    });
    const provider = createGemmaSummaryProvider({
      generate: model.generate,
      tokens: estimateTokens,
    });

    const result = await provider.summarize(request({ lines: transcript(40) }));

    const transcripts = model.steps
      .filter((step) => isPart(step))
      .map((step) => step.user.match(/^You: |^Speaker 1: /gm)?.length);
    expect(transcripts).toEqual([40, 32, 8]);
    expect(result.ok).toBe(true);
  });

  test.each([
    ["no spoken words", [], "noTranscript"],
    ["only blank segments", [{ speaker: "you", startMs: 0, text: "  " }], "noTranscript"],
    ["a greeting", transcript(1, "hello can you hear me"), "tooShort"],
  ] as const)("%s resolves %s without calling the model", async (_, lines, kind) => {
    const model = fakeModel({});
    const provider = createGemmaSummaryProvider({
      generate: model.generate,
      tokens: estimateTokens,
    });

    expect(await provider.summarize(request({ lines }))).toEqual({ ok: false, failure: { kind } });
    expect(model.steps).toEqual([]);
  });

  test.each([
    ["a timed-out step", { ok: false, failure: { kind: "timedOut" } } as const, "timedOut"],
    ["truncated JSON", ok(part(), true), "rejected"],
    ["JSON of another shape", ok('{"summary": "fine"}'), "rejected"],
    [
      "nothing settled at all",
      ok(part({ decisions: [], nextSteps: [], overview: "" })),
      "rejected",
    ],
  ])("%s resolves %s", async (_, answer, kind) => {
    const model = fakeModel({ part: () => answer });
    const provider = createGemmaSummaryProvider({
      generate: model.generate,
      tokens: estimateTokens,
    });

    expect(await provider.summarize(request())).toEqual({ ok: false, failure: { kind } });
  });

  test("an abort rejects with the signal's reason and takes no further step", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped");
    const model = fakeModel({
      part: () => {
        controller.abort(reason);
        throw new DOMException("aborted", "AbortError");
      },
    });
    const provider = createGemmaSummaryProvider({
      generate: model.generate,
      tokens: estimateTokens,
    });

    await expect(
      provider.summarize(request({ signal: controller.signal, title: "generate" })),
    ).rejects.toBe(reason);
    expect(model.steps).toHaveLength(1);
  });

  test("a broken model rejects with its error", async () => {
    const broken = new Error("The transform model stopped unexpectedly.");
    const provider = createGemmaSummaryProvider({
      generate: async () => {
        throw broken;
      },
      tokens: estimateTokens,
    });

    await expect(provider.summarize(request())).rejects.toBe(broken);
  });

  test("a Polish transcript asks for Polish", async () => {
    const model = fakeModel({});
    const provider = createGemmaSummaryProvider({
      generate: model.generate,
      tokens: estimateTokens,
    });
    const polish = transcript(
      10,
      "no dobra to ja się tym zajmę ale nie wiem czy już jest gotowe na piątek",
    );

    const result = await provider.summarize(request({ lines: polish }));

    expect(model.steps[0]!.user).toContain("Polish (polski)");
    expect(result.ok && result.summary.language).toBe("pl");
  });
});

describe("generateTitle", () => {
  test("retries a title outside 3 to 6 words, warmer each time", async () => {
    const answers = ["Plan", 'title: "The Q3 Budget and Hiring Plan."'];
    const model = fakeModel({ title: (attempt) => ok(answers[attempt] ?? "") });
    const provider = createGemmaSummaryProvider({
      generate: model.generate,
      tokens: estimateTokens,
    });

    const result = await provider.generateTitle(request());

    expect(result).toEqual({ ok: true, title: "The Q3 Budget and Hiring Plan" });
    expect(model.steps.map(({ temperature }) => temperature)).toEqual([0, 0.7]);
  });

  test("after three tries it keeps the first usable title", async () => {
    const model = fakeModel({ title: (attempt) => ok(attempt === 0 ? "" : "Budget") });
    const provider = createGemmaSummaryProvider({
      generate: model.generate,
      tokens: estimateTokens,
    });

    expect(await provider.generateTitle(request())).toEqual({ ok: true, title: "Budget" });
    expect(model.steps).toHaveLength(3);
  });

  test("three empty answers are rejected", async () => {
    const model = fakeModel({ title: () => ok("title:") });
    const provider = createGemmaSummaryProvider({
      generate: model.generate,
      tokens: estimateTokens,
    });

    expect(await provider.generateTitle(request())).toEqual({
      ok: false,
      failure: { kind: "rejected" },
    });
  });

  test("a short meeting grounds the title on its whole transcript", async () => {
    const model = fakeModel({});
    const provider = createGemmaSummaryProvider({
      generate: model.generate,
      tokens: estimateTokens,
    });

    await provider.generateTitle(request({ notes: "hotfix 4.12.1" }));

    expect(model.steps[0]!.user).toContain("<transcript>");
    expect(model.steps[0]!.user.match(/You: we agreed/g)).toHaveLength(5);
    expect(model.steps[0]!.user).toContain("hotfix 4.12.1");
  });
});

describe("cleanTitle", () => {
  test.each([
    ["title: Q3 Budget Review", "Q3 Budget Review"],
    ["Title:\nPlanowanie promocji Black Week", "Planowanie promocji Black Week"],
    ['## "Launch Plan Decisions."', "Launch Plan Decisions"],
    ['<field name="title">\nBooking Flow Updates\n</field>', "Booking Flow Updates"],
    ["tytuł: „Przejście na Przelewy24”", "Przejście na Przelewy24"],
    ["Version 4.12.1 Hotfix", "Version 4.12.1 Hotfix"],
  ])("%j becomes %j", (raw, title) => {
    expect(cleanTitle(raw)).toBe(title);
  });

  test("caps the title at 120 characters", () => {
    expect(cleanTitle("word ".repeat(60))).toHaveLength(119);
  });
});

const tokens = (line: string) => line.length;

describe("chunkLines", () => {
  test("packs whole lines into the fewest chunks of about equal size", () => {
    const lines = Array.from({ length: 10 }, () => "x".repeat(99));

    expect(chunkLines(lines, tokens, 450).map((chunk) => chunk.length)).toEqual([3, 3, 4]);
  });

  test("never leaves a few lines over as a chunk of their own", () => {
    const lines = Array.from({ length: 61 }, () => "x".repeat(99));

    const chunks = chunkLines(lines, tokens, 1000);

    expect(chunks).toHaveLength(Math.ceil((61 * 100) / 1000));
    expect(chunks.flat()).toEqual(lines);
  });

  test("a meeting that fits is read whole; a longer one goes in smaller parts", () => {
    const line = "x".repeat(299);

    // 299 characters estimate 100 tokens, plus one for the line break.
    const fitting = Math.floor(WHOLE_TOKENS / 101);
    expect(planParts(Array(fitting).fill(line), estimateTokens)).toHaveLength(1);
    const parts = planParts(Array(fitting + 1).fill(line), estimateTokens);
    expect(parts.length).toBeGreaterThanOrEqual(WHOLE_TOKENS / PART_TOKENS);
  });
});

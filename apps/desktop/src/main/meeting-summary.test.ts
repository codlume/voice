import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import type { MeetingSummary, SummaryProvider, SummaryResult } from "@voice/cleanup/summary";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import type { Meeting, MeetingId, Summary, TranscriptEntry } from "../shared/meetings.ts";
import { meetingMarkdown } from "../shared/meeting-markdown.ts";
import {
  createMeetingSummarizer,
  STEP_BUDGET_MS,
  summaryFailureMessage,
  summaryInput,
} from "./meeting-summary.ts";
import { createMeetingsStore } from "./meetings-store.ts";
import type { GenerateRequest, GenerateResult } from "./transform-model.ts";

const MIN = 60_000;
const START = Date.UTC(2026, 9, 31, 9, 0);
const ID = "11111111-1111-4111-8111-111111111111" as MeetingId;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(NodePath.join(tmpdir(), "voice-meeting-summary-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const transcript: TranscriptEntry[] = [
  {
    kind: "segment",
    id: "a",
    source: "system",
    speaker: "Speaker 1",
    startMs: 0,
    endMs: 4000,
    text: "Can you ship the hotfix today?",
    final: true,
  },
  {
    kind: "segment",
    id: "b",
    source: "mic",
    startMs: 5000,
    endMs: 9000,
    text: "Yes, I will.",
    final: true,
  },
  { kind: "marker", marker: "dictated", atMs: 9500 },
  {
    kind: "segment",
    id: "c",
    source: "system",
    speaker: null,
    startMs: 10_000,
    endMs: 12_000,
    text: "  ",
    final: true,
  },
];

const summary: MeetingSummary = {
  title: "Hotfix Release Plan",
  language: "en",
  overview: "The hotfix ships today, as Speaker 1 asked.",
  decisions: ["Ship the hotfix today."],
  nextSteps: [{ owner: "you", task: "Ship the hotfix." }],
};

const previous: Summary = {
  markdown: "Old summary.",
  overview: "Old summary.",
  generatedAt: START,
  coversUntilMs: 10 * MIN,
};

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: ID,
    title: null,
    createdAt: START,
    spans: [{ startedAt: START, endedAt: START + 30 * MIN }],
    status: { kind: "summarizing" },
    folderIds: [],
    notes: "ship today",
    summary: { kind: "none" },
    ...overrides,
  };
}

async function harness({
  provider,
  onDisk = true,
  generate,
  stored = meeting(),
}: {
  provider?: Partial<SummaryProvider>;
  onDisk?: boolean;
  generate?: (request: GenerateRequest) => Promise<GenerateResult>;
  stored?: Meeting;
}) {
  const logs: string[] = [];
  const store = createMeetingsStore({ dir, log: () => {}, onChange: () => {} });
  await store.loaded();
  await store.put(stored);
  await store.append(ID, transcript);
  const calls: string[] = [];
  const summarizer = createMeetingSummarizer({
    store,
    model: {
      onDisk: () => onDisk,
      generate: generate ?? (async () => ({ ok: false, failure: { kind: "timedOut" } })),
    },
    ...(provider && {
      provider: {
        id: "fake",
        summarize: async () => {
          calls.push("summarize");
          return { ok: true, summary };
        },
        generateTitle: async () => {
          calls.push("generateTitle");
          return { ok: true, title: "Hotfix Release Plan" };
        },
        ...provider,
      },
    }),
    now: () => START + 40 * MIN,
    log: (message) => logs.push(message),
  });
  const saved = async () =>
    JSON.parse(await readFile(NodePath.join(dir, ID, "meeting.json"), "utf8")).meeting as Meeting;
  return { store, summarizer, calls, logs, saved };
}

const signal = () => new AbortController().signal;

describe("summarizeMeeting", () => {
  test("writes the summary with speaker chips, its overview, and a title for a blank one", async () => {
    const { summarizer, store, saved } = await harness({ provider: {} });
    const folder = await store.createFolder({
      name: "Hotfixes",
      kind: "auto",
      rule: { kind: "titleContains", text: "hotfix" },
    });

    expect(await summarizer.summarizeMeeting(ID, { signal: signal() })).toEqual({ ok: true });

    const written = await saved();
    expect(written.title).toEqual({ text: "Hotfix Release Plan", source: "generated" });
    expect(written.folderIds).toEqual([folder.id]);
    expect(written.status).toEqual({ kind: "summarizing" });
    expect(written.summary).toEqual({
      kind: "ready",
      summary: {
        markdown: [
          'The hotfix ships today, as <voice-speaker id="Speaker 1">Speaker 1</voice-speaker> asked.',
          "",
          "### Decisions",
          "",
          "- Ship the hotfix today.",
          "",
          "### Next Steps",
          "",
          '<voice-speaker id="you">You</voice-speaker>',
          "- Ship the hotfix.",
          "",
        ].join("\n"),
        overview:
          'The hotfix ships today, as <voice-speaker id="Speaker 1">Speaker 1</voice-speaker> asked.',
        generatedAt: START + 40 * MIN,
        coversUntilMs: 30 * MIN,
      },
    });
    const exported = meetingMarkdown(written, await store.transcript(ID));
    expect(exported).toContain("as **Speaker 1** asked");
    expect(exported).toContain("### Next Steps\n\n**You**\n- Ship the hotfix.");
  });

  test("keeps a title the user typed while the summary ran", async () => {
    const { summarizer, store, saved } = await harness({
      provider: {
        summarize: async (): Promise<SummaryResult> => {
          await store.update(ID, (latest) => ({
            ...latest,
            title: { text: "Ops sync", source: "user" },
          }));
          return { ok: true, summary };
        },
      },
    });

    await summarizer.summarizeMeeting(ID, { signal: signal() });

    expect((await saved()).title).toEqual({ text: "Ops sync", source: "user" });
  });

  test("asks for a title only when the title is blank, with the notes and transcript", async () => {
    let seen: Parameters<SummaryProvider["summarize"]>[0] | undefined;
    const { summarizer } = await harness({
      stored: meeting({ title: { text: "Ops sync", source: "user" } }),
      provider: {
        summarize: async (request) => {
          seen = request;
          return { ok: true, summary };
        },
      },
    });

    await summarizer.summarizeMeeting(ID, { signal: signal() });

    expect(seen).toMatchObject({
      title: "keep",
      notes: "ship today",
      lines: [
        { speaker: "Speaker 1", startMs: 0, text: "Can you ship the hotfix today?" },
        { speaker: "you", startMs: 5000, text: "Yes, I will." },
      ],
      speakers: [
        { id: "you", label: "You" },
        { id: "Speaker 1", label: "Speaker 1" },
      ],
    });
  });

  test("a failure keeps the transcript and the previous summary", async () => {
    const { summarizer, store, saved } = await harness({
      stored: meeting({ summary: { kind: "ready", summary: previous } }),
      provider: { summarize: async () => ({ ok: false, failure: { kind: "rejected" } }) },
    });

    expect(await summarizer.summarizeMeeting(ID, { signal: signal() })).toEqual({
      ok: false,
      failure: { kind: "rejected" },
    });

    expect((await saved()).summary).toEqual({
      kind: "failed",
      message: summaryFailureMessage.rejected,
      previous,
    });
    expect(await store.transcript(ID)).toHaveLength(transcript.length);
  });

  test("a failure after a failure still keeps the last good summary", async () => {
    const { summarizer, saved } = await harness({
      stored: meeting({ summary: { kind: "failed", message: "x", previous } }),
      provider: { summarize: async () => ({ ok: false, failure: { kind: "timedOut" } }) },
    });

    await summarizer.summarizeMeeting(ID, { signal: signal() });

    expect((await saved()).summary).toMatchObject({ kind: "failed", previous });
  });

  test("without the model on disk it fails as modelUnavailable and never asks the provider", async () => {
    const { summarizer, calls, saved } = await harness({ provider: {}, onDisk: false });

    expect(await summarizer.summarizeMeeting(ID, { signal: signal() })).toEqual({
      ok: false,
      failure: { kind: "modelUnavailable" },
    });
    expect(calls).toEqual([]);
    expect((await saved()).summary).toMatchObject({
      kind: "failed",
      message: summaryFailureMessage.modelUnavailable,
    });
  });

  test("a model that breaks mid-run is reported stopped and logged", async () => {
    const { summarizer, logs, saved } = await harness({
      provider: {
        summarize: async () => {
          throw new Error("The transform model stopped unexpectedly.");
        },
      },
    });

    expect(await summarizer.summarizeMeeting(ID, { signal: signal() })).toEqual({
      ok: false,
      failure: { kind: "stopped" },
    });
    expect(logs).toEqual([
      "meetings: summary model stopped (The transform model stopped unexpectedly.)",
    ]);
    expect((await saved()).summary).toMatchObject({ kind: "failed" });
  });

  test("an abort rejects with its reason and writes nothing", async () => {
    const controller = new AbortController();
    const reason = new Error("Meeting deleted");
    const { summarizer, saved } = await harness({
      provider: {
        summarize: async () => {
          controller.abort(reason);
          throw reason;
        },
      },
    });

    await expect(summarizer.summarizeMeeting(ID, { signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect((await saved()).summary).toEqual({ kind: "none" });
  });

  test("runs the Gemma provider step by step through the transform model, with progress", async () => {
    const steps: GenerateRequest[] = [];
    const progress: number[] = [];
    const long = Array.from(
      { length: 20 },
      () => "we ship the hotfix today and write the notes",
    ).join(" ");
    const { summarizer, store, saved } = await harness({
      generate: async (request) => {
        steps.push(request);
        if (request.jsonSchema) {
          return {
            ok: true,
            truncated: false,
            text: JSON.stringify({
              topics: ["The hotfix."],
              decisions: [{ decision: "Ship today.", status: "final" }],
              nextSteps: [{ owner: "You", task: "Ship the hotfix today.", status: "agreed" }],
              overview: "The hotfix ships today.",
            }),
          };
        }
        return { ok: true, truncated: false, text: "title: Hotfix Plan For Today" };
      },
    });
    await store.append(ID, [
      {
        kind: "segment",
        id: "d",
        source: "mic",
        startMs: 20_000,
        endMs: 60_000,
        text: long,
        final: true,
      },
    ]);

    await summarizer.summarizeMeeting(ID, {
      signal: signal(),
      onProgress: ({ done, total }) => progress.push(done / total),
    });

    expect(steps.map(({ budgetMs }) => budgetMs)).toEqual([STEP_BUDGET_MS, STEP_BUDGET_MS]);
    expect(progress).toEqual([0.5, 1]);
    expect(await saved()).toMatchObject({
      title: { text: "Hotfix Plan For Today", source: "generated" },
      summary: { kind: "ready", summary: { overview: "The hotfix ships today." } },
    });
  });
});

describe("generateTitle", () => {
  test("writes a title for a blank one", async () => {
    const { summarizer, saved } = await harness({ provider: {} });

    expect(await summarizer.generateTitle(ID, { signal: signal() })).toEqual({
      ok: true,
      title: "Hotfix Release Plan",
    });
    expect((await saved()).title).toEqual({ text: "Hotfix Release Plan", source: "generated" });
  });

  test("leaves a titled meeting alone without asking the model", async () => {
    const { summarizer, calls } = await harness({
      provider: {},
      stored: meeting({ title: { text: "Ops sync", source: "user" } }),
    });

    expect(await summarizer.generateTitle(ID, { signal: signal() })).toEqual({
      ok: true,
      title: null,
    });
    expect(calls).toEqual([]);
  });

  test("a failed title changes nothing", async () => {
    const { summarizer, saved } = await harness({
      provider: { generateTitle: async () => ({ ok: false, failure: { kind: "tooShort" } }) },
    });

    expect(await summarizer.generateTitle(ID, { signal: signal() })).toEqual({
      ok: false,
      failure: { kind: "tooShort" },
    });
    expect((await saved()).title).toBeNull();
  });
});

test("summaryInput names the mic You, an unknown voice Others, and drops blank segments", () => {
  const { lines, speakers } = summaryInput([
    ...transcript,
    {
      kind: "segment",
      id: "e",
      source: "system",
      speaker: null,
      startMs: 13_000,
      endMs: 14_000,
      text: "Bye.",
      final: true,
    },
  ]);

  expect(speakers).toEqual([
    { id: "you", label: "You" },
    { id: "Speaker 1", label: "Speaker 1" },
    { id: "others", label: "Others" },
  ]);
  expect(lines.map(({ speaker }) => speaker)).toEqual(["Speaker 1", "you", "others"]);
});

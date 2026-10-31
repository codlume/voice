import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import type {
  MeetingSummary,
  SummaryProgress,
  SummaryProvider,
  SummaryResult,
} from "@voice/cleanup/summary";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import {
  renameSpeaker,
  resolveSpeakerTokens,
  type Meeting,
  type MeetingId,
  type SpeakerId,
  type Summary,
  type TranscriptEntry,
} from "../shared/meetings.ts";
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
    speakerId: "s1" as SpeakerId,
    startMs: 0,
    endMs: 4000,
    text: "Can you ship the hotfix today?",
  },
  {
    kind: "segment",
    id: "b",
    source: "mic",
    startMs: 5000,
    endMs: 9000,
    text: "Yes, I will.",
  },
  { kind: "marker", marker: "dictated", atMs: 9500 },
  {
    kind: "segment",
    id: "c",
    source: "system",
    speakerId: null,
    startMs: 10_000,
    endMs: 12_000,
    text: "  ",
  },
];

const summary: MeetingSummary = {
  title: "Hotfix Release Plan",
  overview: "The hotfix ships today, as Speaker 1 asked.",
  decisions: ["Ship the hotfix today."],
  nextSteps: [
    { owner: "you", task: "Ship the hotfix." },
    { owner: "s1", task: "Tell support." },
  ],
};

const previous: Summary = {
  markdown: "Old summary.",
  coversUntilMs: 10 * MIN,
};

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: ID,
    title: null,
    createdAt: START,
    spans: [{ startedAt: START, endedAt: START + 30 * MIN }],
    status: { kind: "summarizing", progress: null },
    folderIds: [],
    notes: "ship today",
    summary: { kind: "none" },
    speakers: [{ id: "s1" as SpeakerId, label: "Speaker 1", name: null }],
    finalPassFailed: false,
    transcriptRevision: 0,
    ...overrides,
  };
}

async function harness({
  provider,
  onDisk = true,
  foundOnRefresh = false,
  generate,
  stored = meeting(),
}: {
  provider?: Partial<SummaryProvider>;
  onDisk?: boolean;
  foundOnRefresh?: boolean;
  generate?: (request: GenerateRequest) => Promise<GenerateResult>;
  stored?: Meeting;
}) {
  const logs: string[] = [];
  const store = createMeetingsStore({ dir, log: () => {}, onChange: () => {} });
  await store.loaded();
  await store.upsert(stored.id, () => stored);
  await store.append(ID, transcript);
  const calls: string[] = [];
  let present = onDisk;
  const summarizer = createMeetingSummarizer({
    store,
    model: {
      onDisk: () => present,
      refresh: async () => {
        calls.push("refresh");
        present ||= foundOnRefresh;
      },
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
  test("writes the summary with speaker tokens, and a title for a blank one", async () => {
    const { summarizer, store, saved } = await harness({ provider: {} });
    const folder = await store.createFolder({
      name: "Hotfixes",
      kind: "auto",
      rule: { kind: "titleContains", text: "hotfix" },
    });

    expect(await summarizer.summarizeMeeting(ID, { signal: signal() })).toEqual({ ok: true });

    const written = await saved();
    expect(written.title).toEqual("Hotfix Release Plan");
    expect(written.folderIds).toEqual([folder.id]);
    expect(written.status).toEqual({ kind: "summarizing", progress: null });
    expect(written.summary).toEqual({
      kind: "ready",
      summary: {
        markdown: [
          "The hotfix ships today, as {{speaker:s1}} asked.",
          "",
          "### Decisions",
          "",
          "- Ship the hotfix today.",
          "",
          "### Next Steps",
          "",
          "**{{speaker:you}}**",
          "- Ship the hotfix.",
          "",
          "**{{speaker:s1}}**",
          "- Tell support.",
          "",
        ].join("\n"),
        coversUntilMs: 30 * MIN,
      },
    });
  });

  test("a rename shows in the summary and its export without regenerating", async () => {
    const { summarizer, store, calls } = await harness({ provider: {} });
    await summarizer.summarizeMeeting(ID, { signal: signal() });

    const renamed = await store.update(ID, (latest) =>
      renameSpeaker(latest, "s1" as SpeakerId, "Ana"),
    );

    const { summary: state } = renamed!;
    const markdown = state.kind === "ready" ? state.summary.markdown : "";
    expect(resolveSpeakerTokens(markdown, renamed!.speakers).split("\n")[0]).toBe(
      "The hotfix ships today, as Ana asked.",
    );
    const exported = meetingMarkdown(renamed!, await store.transcript(ID));
    expect(exported).toContain("as Ana asked");
    expect(exported).toContain("**You**\n- Ship the hotfix.\n\n**Ana**\n- Tell support.");
    expect(calls).toEqual(["summarize"]);
  });

  test("keeps a title the user typed while the summary ran", async () => {
    const { summarizer, store, saved } = await harness({
      provider: {
        summarize: async (): Promise<SummaryResult> => {
          await store.update(ID, (latest) => ({
            ...latest,
            title: "Ops sync",
          }));
          return { ok: true, summary };
        },
      },
    });

    await summarizer.summarizeMeeting(ID, { signal: signal() });

    expect((await saved()).title).toEqual("Ops sync");
  });

  test("asks for a title only when the title is blank, with the notes and transcript", async () => {
    let seen: Parameters<SummaryProvider["summarize"]>[0] | undefined;
    const { summarizer } = await harness({
      stored: meeting({ title: "Ops sync" }),
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
        { speaker: "s1", startMs: 0, text: "Can you ship the hotfix today?" },
        { speaker: "you", startMs: 5000, text: "Yes, I will." },
      ],
      speakers: [
        { id: "you", label: "You" },
        { id: "s1", label: "Speaker 1" },
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
    expect(calls).toEqual(["refresh"]);
    expect((await saved()).summary).toMatchObject({
      kind: "failed",
      message: summaryFailureMessage.modelUnavailable,
    });
  });

  test("looks at the disk again before giving up, as a meeting recovered at launch needs", async () => {
    const { summarizer, calls } = await harness({
      provider: {},
      onDisk: false,
      foundOnRefresh: true,
    });

    expect(await summarizer.summarizeMeeting(ID, { signal: signal() })).toEqual({ ok: true });
    expect(calls).toEqual(["refresh", "summarize"]);
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
    const progress: SummaryProgress[] = [];
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
      },
    ]);

    await summarizer.summarizeMeeting(ID, {
      signal: signal(),
      onProgress: (step) => progress.push(step),
    });

    expect(steps.map(({ budgetMs }) => budgetMs)).toEqual([STEP_BUDGET_MS, STEP_BUDGET_MS]);
    expect(progress).toEqual([
      { step: 1, total: 2 },
      { step: 2, total: 2 },
    ]);
    const written = await saved();
    expect(written.title).toEqual("Hotfix Plan For Today");
    expect(written.summary).toMatchObject({
      kind: "ready",
      summary: { markdown: expect.stringMatching(/^The hotfix ships today\.\n/) },
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
    expect((await saved()).title).toEqual("Hotfix Release Plan");
  });

  test("leaves a titled meeting alone without asking the model", async () => {
    const { summarizer, calls } = await harness({
      provider: {},
      stored: meeting({ title: "Ops sync" }),
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

test("summaryInput names the mic You, speakers by their name, an unknown voice Others, and drops blank segments", () => {
  const speakers = [
    { id: "s1" as SpeakerId, label: "Speaker 1", name: "Ana" },
    { id: "s2" as SpeakerId, label: "Speaker 2", name: "Ana" },
  ];
  const { lines, speakers: read } = summaryInput(
    [
      ...transcript,
      {
        kind: "segment",
        id: "e",
        source: "system",
        speakerId: null,
        startMs: 13_000,
        endMs: 14_000,
        text: "Bye.",
      },
      {
        kind: "segment",
        id: "f",
        source: "system",
        speakerId: "s2" as SpeakerId,
        startMs: 15_000,
        endMs: 16_000,
        text: "Bye all.",
      },
    ],
    speakers,
  );

  // A second Ana keeps her label, so each owner the model names is one speaker.
  expect(read).toEqual([
    { id: "you", label: "You" },
    { id: "s1", label: "Ana" },
    { id: "others", label: "Others" },
    { id: "s2", label: "Speaker 2" },
  ]);
  expect(lines.map(({ speaker }) => speaker)).toEqual(["s1", "you", "others", "s2"]);
});

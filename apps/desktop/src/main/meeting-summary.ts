import {
  createGemmaSummaryProvider,
  estimateTokens,
  renderSummaryMarkdown,
  type Speaker,
  type SummaryFailure,
  type SummaryProgress,
  type SummaryProvider,
  type TranscriptLine,
} from "@voice/cleanup/summary";

import {
  autoFolderIds,
  recordedMs,
  speakerName,
  type Meeting,
  type MeetingId,
  type Segment,
  type SummaryState,
  type TranscriptEntry,
} from "../shared/meetings.ts";
import type { MeetingsStore } from "./meetings-store.ts";
import type { TransformModel } from "./transform-model.ts";

/** `stopped` is a model that broke mid-run, as opposed to an answer it could not give. */
export type SummaryOutcomeFailure = SummaryFailure | { kind: "stopped" };

export type SummaryOutcome = { ok: true } | { ok: false; failure: SummaryOutcomeFailure };

export type TitleOutcome =
  | { ok: true; title: string | null }
  | { ok: false; failure: SummaryOutcomeFailure };

/**
 * Summaries and titles for meetings, written to the meeting as they finish. Both run after Stop,
 * never on the dictation path, one model step at a time, so a Transform waits for one step at
 * most. Aborting rejects with the signal's reason and writes nothing.
 */
export type MeetingSummarizer = {
  /**
   * Writes the summary, and a generated title when the title is blank. A failure is written with
   * the previous summary kept; the transcript is never touched.
   */
  summarizeMeeting(
    id: MeetingId,
    options: { signal: AbortSignal; onProgress?: (progress: SummaryProgress) => void },
  ): Promise<SummaryOutcome>;
  /** Writes a generated title when the title is blank, for a meeting not summarized yet. */
  generateTitle(id: MeetingId, options: { signal: AbortSignal }): Promise<TitleOutcome>;
};

/** A 12,000-token step took up to 52 s on an M1 Pro (measured); slower Macs and a queued Transform get room. */
export const STEP_BUDGET_MS = 240_000;

export const summaryFailureMessage: Record<SummaryOutcomeFailure["kind"], string> = {
  tooShort: "The meeting was too short to summarize.",
  noTranscript: "There is no transcript to summarize.",
  modelUnavailable: "Download the Transforms model to summarize meetings.",
  timedOut: "The summary took too long.",
  rejected: "The summary model gave no usable summary.",
  stopped: "The summary model stopped.",
};

const MIC_SPEAKER = "you";

const speakerId = (segment: Segment) =>
  segment.source === "mic" ? MIC_SPEAKER : (segment.speaker ?? "others");

/** The transcript as the provider reads it; You first, then everyone in order of first word. */
export function summaryInput(transcript: readonly TranscriptEntry[]): {
  lines: TranscriptLine[];
  speakers: Speaker[];
} {
  const segments = transcript.filter(
    (entry): entry is Segment => entry.kind === "segment" && entry.text.trim() !== "",
  );
  const speakers = new Map<string, Speaker>();
  for (const segment of segments.toSorted(
    (a, b) => Number(b.source === "mic") - Number(a.source === "mic"),
  )) {
    const id = speakerId(segment);
    if (!speakers.has(id)) speakers.set(id, { id, label: speakerName(segment) });
  }
  return {
    lines: segments.map((segment) => ({
      speaker: speakerId(segment),
      startMs: segment.startMs,
      text: segment.text,
    })),
    speakers: [...speakers.values()],
  };
}

const lastSummary = (summary: SummaryState) =>
  summary.kind === "ready" ? summary.summary : summary.kind === "failed" ? summary.previous : null;

const failed = (meeting: Meeting, failure: SummaryOutcomeFailure): Meeting => ({
  ...meeting,
  summary: {
    kind: "failed",
    message: summaryFailureMessage[failure.kind],
    previous: lastSummary(meeting.summary),
  },
});

export function createMeetingSummarizer({
  store,
  model,
  provider = createGemmaSummaryProvider({
    tokens: estimateTokens,
    generate: (step) => model.generate({ ...step, budgetMs: STEP_BUDGET_MS }),
  }),
  now = Date.now,
  log,
}: {
  store: Pick<MeetingsStore, "get" | "transcript" | "update" | "state">;
  model: Pick<TransformModel, "onDisk" | "generate">;
  provider?: SummaryProvider;
  now?: () => number;
  log: (message: string) => void;
}): MeetingSummarizer {
  /** Fills a blank title, the auto folders it matches included; a title the user typed meanwhile wins. */
  const withTitle = (meeting: Meeting, title: string | null): Meeting => {
    if (meeting.title !== null || title === null) return meeting;
    const titled: Meeting = { ...meeting, title: { text: title, source: "generated" } };
    const { folders, settings } = store.state();
    const added = autoFolderIds(titled, folders, settings).filter(
      (folderId) => !meeting.folderIds.includes(folderId),
    );
    return { ...titled, folderIds: [...meeting.folderIds, ...added] };
  };

  async function run<T>(
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T | { ok: false; failure: SummaryOutcomeFailure }> {
    if (!model.onDisk()) return { ok: false, failure: { kind: "modelUnavailable" } };
    try {
      return await work();
    } catch (error) {
      signal.throwIfAborted();
      log(
        `meetings: summary model stopped (${error instanceof Error ? error.message : String(error)})`,
      );
      return { ok: false, failure: { kind: "stopped" } };
    }
  }

  return {
    async summarizeMeeting(id, { signal, onProgress }) {
      signal.throwIfAborted();
      const meeting = store.get(id);
      if (meeting === null) return { ok: false, failure: { kind: "noTranscript" } };
      const coversUntilMs = recordedMs(meeting, now());
      const input = summaryInput(await store.transcript(id));
      const outcome = await run(signal, () =>
        provider.summarize({
          ...input,
          notes: meeting.notes,
          title: meeting.title === null ? "generate" : "keep",
          signal,
          ...(onProgress && { onProgress }),
        }),
      );
      signal.throwIfAborted();
      if (!outcome.ok) {
        await store.update(id, (latest) => failed(latest, outcome.failure));
        return outcome;
      }
      const { summary } = outcome;
      const { markdown, overview } = renderSummaryMarkdown(summary, input.speakers);
      await store.update(id, (latest) => ({
        ...withTitle(latest, summary.title),
        summary: {
          kind: "ready",
          summary: { markdown, overview, generatedAt: now(), coversUntilMs },
        },
      }));
      return { ok: true };
    },

    async generateTitle(id, { signal }) {
      signal.throwIfAborted();
      const meeting = store.get(id);
      if (meeting === null || meeting.title !== null) return { ok: true, title: null };
      const input = summaryInput(await store.transcript(id));
      const outcome = await run(signal, () =>
        provider.generateTitle({ ...input, notes: meeting.notes, signal }),
      );
      signal.throwIfAborted();
      if (!outcome.ok) return outcome;
      let written: string | null = null;
      await store.update(id, (latest) => {
        const titled = withTitle(latest, outcome.title);
        if (titled !== latest) written = outcome.title;
        return titled;
      });
      return { ok: true, title: written };
    },
  };
}

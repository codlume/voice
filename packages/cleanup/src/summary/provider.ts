/** "you" for the mic, otherwise the meeting's id for a voice, such as "s1". */
export type SpeakerId = string;

/** `label` is what the transcript calls the speaker now, which a rename can change. */
export type Speaker = { id: SpeakerId; label: string };

export type TranscriptLine = { speaker: SpeakerId; startMs: number; text: string };

export type SummaryProgress = { done: number; total: number };

export type SummaryRequest = {
  /** The final transcript in time order; dictated spans already left out. */
  lines: readonly TranscriptLine[];
  speakers: readonly Speaker[];
  /** The user's "My thoughts", secondary context only. */
  notes: string;
  /** Only a blank title is generated. */
  title: "generate" | "keep";
  signal: AbortSignal;
  onProgress?: (progress: SummaryProgress) => void;
};

export type NextStep = { owner: SpeakerId | null; task: string };

/** Free text is plain; owners are ids, so the renderer, not the model, writes every speaker token. */
export type MeetingSummary = {
  title: string | null;
  /** The transcript's language, which picks the headings. */
  language: string;
  overview: string;
  decisions: readonly string[];
  nextSteps: readonly NextStep[];
};

export type SummaryFailure =
  | { kind: "tooShort" }
  | { kind: "noTranscript" }
  | { kind: "modelUnavailable" }
  | { kind: "timedOut" }
  | { kind: "rejected" };

export type SummaryResult =
  | { ok: true; summary: MeetingSummary }
  | { ok: false; failure: SummaryFailure };

export type TitleRequest = Omit<SummaryRequest, "title" | "onProgress">;

export type TitleResult = { ok: true; title: string } | { ok: false; failure: SummaryFailure };

/**
 * Expected failures resolve as data. Aborting rejects with the signal's reason and a broken model
 * rejects with its error, the same rule as the transform engine.
 */
export type SummaryProvider = {
  readonly id: string;
  summarize(request: SummaryRequest): Promise<SummaryResult>;
  generateTitle(request: TitleRequest): Promise<TitleResult>;
};

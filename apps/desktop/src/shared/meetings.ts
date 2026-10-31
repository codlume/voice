import { SPEAKER_TOKEN } from "@voice/cleanup/summary";
import type { Shortcut } from "./transforms.ts";

export type MeetingId = string & { readonly __brand: "MeetingId" };
export type FolderId = string & { readonly __brand: "FolderId" };

// Ids name directories under userData, so anything but a UUID is refused before it reaches a path.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const parseMeetingId = (value: unknown): MeetingId | null =>
  typeof value === "string" && UUID.test(value) ? (value as MeetingId) : null;

export const parseFolderId = (value: unknown): FolderId | null =>
  typeof value === "string" && UUID.test(value) ? (value as FolderId) : null;

/** One recording leg, start to stop or pause, in wall-clock ms. */
export type Span = { startedAt: number; endedAt: number };

/** `step` counts from 1; a long meeting is summarized in parts, and `total` can grow. */
export type SummaryProgress = { step: number; total: number };

/**
 * Where the meeting is in its lifecycle. `starting` remembers what a failed capture start returns
 * to: a new meeting has nothing to keep. `finishing` catches the live transcript up after Stop;
 * `transcribing` does the same after a crash (`draining`), then runs the final pass.
 */
export type MeetingStatus =
  | { kind: "starting"; from: "new" | "paused" | "ready" }
  | { kind: "recording"; since: number }
  | { kind: "paused" }
  | { kind: "finishing" }
  | { kind: "confirmingShort" }
  | { kind: "transcribing"; step: "draining" | "finalizing" }
  | { kind: "summarizing"; progress: SummaryProgress | null }
  | { kind: "ready" };

/**
 * `coversUntilMs` is the recorded length the summary was made from; more recording makes it stale.
 * `markdown` names speakers with `speakerToken`, so a rename needs no regeneration.
 */
export type Summary = { markdown: string; coversUntilMs: number };

export type SummaryState =
  | { kind: "none" }
  | { kind: "ready"; summary: Summary }
  | { kind: "failed"; message: string; previous: Summary | null };

export type SpeakerId = string & { readonly __brand: "SpeakerId" };

/**
 * One voice on system audio, found by diarization. The id and the "Speaker N" label never change,
 * so a rename shows everywhere the id is used, including summaries written before it. `name` is
 * the user's rename.
 */
export type Speaker = { id: SpeakerId; label: string; name: string | null };

/** What `meeting.json` holds. The transcript lives in its own append-only file. */
export type Meeting = {
  id: MeetingId;
  /** A blank title is null, which lets the summary step generate one. */
  title: string | null;
  createdAt: number;
  /** Closed legs, oldest first. An open leg is `status.since`. */
  spans: readonly Span[];
  status: MeetingStatus;
  folderIds: readonly FolderId[];
  /** The user's "My thoughts". Summaries never touch it. */
  notes: string;
  summary: SummaryState;
  /** The voices on system audio, in the order they first spoke. */
  speakers: readonly Speaker[];
  /**
   * The final pass failed, so the live transcript stands in and the audio is kept until the user
   * tries again or deletes it.
   */
  finalPassFailed: boolean;
  /**
   * Counts every write to the transcript file, appends and rewrites alike. Appends reach open
   * windows as lines tagged with their revision; a meeting whose revision is ahead of the lines a
   * window holds was rewritten, so the window reads the file again.
   */
  transcriptRevision: number;
};

/** Transcript times are ms of recorded audio from the meeting's start, pauses left out. */
export type Segment = {
  kind: "segment";
  id: string;
  startMs: number;
  endMs: number;
  text: string;
} & Voice;

/** The mic is the user. System audio is everyone else: one speaker once diarized, else null. */
export type Voice = { source: "mic" } | { source: "system"; speakerId: SpeakerId | null };
export type MeetingSource = Voice["source"];

export const markerKinds = ["paused", "resumed", "dictated", "gap"] as const;
export type MarkerKind = (typeof markerKinds)[number];

/** `dictated` stands in for words the user dictated elsewhere; `gap` is audio capture lost. */
export type Marker = { kind: "marker"; marker: MarkerKind; atMs: number };

export type TranscriptEntry = Segment | Marker;

export type MeetingDetail = { meeting: Meeting; transcript: readonly TranscriptEntry[] };

/** Rules read only what the meeting itself holds. Calendar-based rules are out of scope. */
export type AutoRule = { kind: "titleContains"; text: string };

export type FolderKind = { kind: "manual" } | { kind: "auto"; rule: AutoRule };

export type Folder = { id: FolderId; name: string; createdAt: number } & FolderKind;

export type FolderDraft = { name: string } & FolderKind;

export const maxLengths = ["30m", "1h", "2h", "3h"] as const;
export type MaxLength = (typeof maxLengths)[number];

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export const maxLengthMs: Record<MaxLength, number> = {
  "30m": 30 * MINUTE_MS,
  "1h": 60 * MINUTE_MS,
  "2h": 120 * MINUTE_MS,
  "3h": 180 * MINUTE_MS,
};

export const meetingRetentions = [
  "day",
  "week",
  "month",
  "quarter",
  "halfYear",
  "year",
  "forever",
] as const;
export type MeetingRetention = (typeof meetingRetentions)[number];

export const meetingRetentionMs: Record<MeetingRetention, number> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  quarter: 90 * DAY_MS,
  halfYear: 180 * DAY_MS,
  year: 365 * DAY_MS,
  forever: Infinity,
};

export type MeetingsSettings = {
  maxLength: MaxLength;
  silencePrompt: boolean;
  openSummaryWhenReady: boolean;
  retention: MeetingRetention;
  autoFolders: boolean;
};

export const DEFAULT_MEETINGS_SETTINGS: MeetingsSettings = {
  maxLength: "2h",
  silencePrompt: true,
  openSummaryWhenReady: true,
  retention: "forever",
  autoFolders: true,
};

export type MeetingsSettingsPatch = Partial<MeetingsSettings>;

const pick = <T>(options: readonly T[], value: unknown): T | undefined =>
  options.find((option) => option === value);

/** Keeps the fields that parse and drops the rest. */
export function parseMeetingsSettingsPatch(raw: unknown): MeetingsSettingsPatch {
  if (typeof raw !== "object" || raw === null) return {};
  const record = raw as Record<string, unknown>;
  const patch: MeetingsSettingsPatch = {};
  const maxLength = pick(maxLengths, record.maxLength);
  if (maxLength) patch.maxLength = maxLength;
  const retention = pick(meetingRetentions, record.retention);
  if (retention) patch.retention = retention;
  for (const key of ["silencePrompt", "openSummaryWhenReady", "autoFolders"] as const) {
    const value = record[key];
    if (typeof value === "boolean") patch[key] = value;
  }
  return patch;
}

/** Meetings newest first, with folders and settings, which are small enough to send whole. */
export type MeetingsState = {
  meetings: readonly Meeting[];
  folders: readonly Folder[];
  settings: MeetingsSettings;
};

export type MeetingsChange =
  | { kind: "all"; state: MeetingsState }
  | ({ kind: "patch"; upsert: readonly Meeting[]; remove: readonly MeetingId[] } & Omit<
      MeetingsState,
      "meetings"
    >);

const newestFirst = (a: Meeting, b: Meeting) => b.createdAt - a.createdAt;

export function applyMeetingsChange(
  state: MeetingsState | null,
  change: MeetingsChange,
): MeetingsState | null {
  if (change.kind === "all") return change.state;
  if (state === null) return null;
  const touched = new Set<MeetingId>([...change.remove, ...change.upsert.map(({ id }) => id)]);
  const meetings = [
    ...state.meetings.filter(({ id }) => !touched.has(id)),
    ...change.upsert,
  ].toSorted(newestFirst);
  return { meetings, folders: change.folders, settings: change.settings };
}

/** Option+M, on the "M" key's position whatever the layout types there. */
export const DEFAULT_MEETING_SHORTCUT: Shortcut = { keycode: 46, modifiers: ["option"] };

/** Statuses that hold a capture open or can resume one. At most one meeting is live. */
export type LiveStatus = Extract<MeetingStatus, { kind: "starting" | "recording" | "paused" }>;
export type LiveMeeting = Meeting & { status: LiveStatus };

/** A capture is open or opening. */
export const isCapturing = ({ status }: Meeting): boolean =>
  status.kind === "starting" || status.kind === "recording";

export const isLive = (meeting: Meeting): meeting is LiveMeeting =>
  isCapturing(meeting) || meeting.status.kind === "paused";

export const liveMeeting = (meetings: readonly Meeting[]): LiveMeeting | null =>
  meetings.find(isLive) ?? null;

/**
 * What the meeting shortcut and the menu bar item do now: stop the live meeting, wait while it
 * starts, or start one.
 */
export type MeetingToggle = { kind: "start" } | { kind: "stop" | "wait"; id: MeetingId };

export function meetingToggle(meetings: readonly Meeting[]): MeetingToggle {
  const live = liveMeeting(meetings);
  if (!live) return { kind: "start" };
  return { kind: live.status.kind === "starting" ? "wait" : "stop", id: live.id };
}

export const meetingToggleLabels: Record<MeetingToggle["kind"], string> = {
  start: "Start meeting",
  stop: "Stop meeting",
  wait: "Starting meeting…",
};

/** `refused` carries a message for the user: the command did nothing. */
export type MeetingCommandResult =
  | { kind: "ok"; id: MeetingId }
  | { kind: "refused"; message: string };

/** Why a source stopped mid-meeting: its permission was taken away, or its device went silent. */
export type AudioLoss = { source: MeetingSource; reason: "permission" | "device" };

/** What a meeting tells the user: warnings, prompts and outcomes. */
export type MeetingNotice =
  | { kind: "startFailed"; message: string }
  | { kind: "resumeFailed"; message: string }
  /** `loss` is null when capture failed some other way, such as the helper stopping. */
  | { kind: "captureLost"; loss: AudioLoss | null }
  | { kind: "maxLengthSoon"; inMs: number }
  | { kind: "maxLengthReached" }
  | { kind: "atMaxLength" }
  | { kind: "silence" }
  /** Nobody answered "Still in a meeting?", so the recording stopped. */
  | { kind: "silenceStopped" }
  | { kind: "finalPassFailed" }
  /** `open` brings the Voice window up on the summary, without taking focus. */
  | { kind: "summaryReady"; open: boolean }
  /** `message` says why, as the meeting's summary state does. */
  | { kind: "summaryFailed"; message: string | null };

/**
 * A warning or question the notepad and the Flow Bar show where the user is, until it is
 * answered or stops applying. `endsAt` is the wall-clock time the recording will stop.
 */
export type MeetingPrompt =
  | { kind: "startedByMistake" }
  | { kind: "silence" }
  | { kind: "maxLengthSoon"; endsAt: number }
  | { kind: "summaryReady" }
  | { kind: "notice"; text: string };

/** Main asks the Voice window to show a meeting, as when its summary is ready. */
export type OpenMeetingRequest = { id: MeetingId; tab: "summary" };

/** What the user can do from a notice besides dismissing it. */
export type MeetingNoticeAction = "viewSummary" | "retryFinalPass" | "deleteAudio";

/**
 * A notice the Meetings page shows until the user dismisses it or it no longer applies. `key`
 * tells two notices apart; the notepad's prompt from the same notice shares it. One that is not
 * `dismissable` stays until what it reports is resolved.
 */
export type MeetingBanner = {
  key: number;
  id: MeetingId;
  text: string;
  actions: readonly MeetingNoticeAction[];
  dismissable: boolean;
};

export const meetingNoticeActionLabels: Record<MeetingNoticeAction, string> = {
  viewSummary: "View summary",
  retryFinalPass: "Try again",
  deleteAudio: "Delete audio",
};

function lostText(loss: AudioLoss | null): string {
  const what =
    loss === null
      ? "Audio stopped coming in"
      : loss.reason === "permission"
        ? `Voice is no longer allowed to record ${loss.source === "mic" ? "the microphone" : "system audio"}`
        : loss.source === "mic"
          ? "The microphone stopped"
          : "System audio stopped";
  return `${what}, so the meeting is paused. Resume to keep recording.`;
}

/** What a notice says, or null for one that only asks a question. */
export function noticeText(notice: MeetingNotice): string | null {
  switch (notice.kind) {
    case "startFailed":
    case "resumeFailed":
      return notice.message;
    case "captureLost":
      return lostText(notice.loss);
    case "maxLengthReached":
      return "Recording stopped at the maximum length.";
    case "silenceStopped":
      return "Recording stopped after 10 minutes without speech.";
    case "atMaxLength":
      return "This meeting is at its maximum length and cannot record more.";
    case "finalPassFailed":
      return "The final transcript could not be made. The live transcript is kept, and so is the audio until you try again or delete it.";
    case "summaryFailed":
      return `The summary could not be written.${notice.message ? ` ${notice.message}` : ""}`;
    case "summaryReady":
      return "Your summary is ready.";
    case "maxLengthSoon":
    case "silence":
      return null;
  }
}

/** The meeting the floating notepad shows, with the prompt it waits on. */
export type NotepadState = { meeting: Meeting; prompt: MeetingPrompt | null };

/** Statuses the Flow Bar shows: a capture open or resumable, or an answer the user owes. */
export type PillMeetingStatus = Extract<
  MeetingStatus,
  { kind: "starting" | "recording" | "paused" | "finishing" | "confirmingShort" }
>;

/** What the Flow Bar shows of the current meeting. `closedMs` leaves out the open leg. */
export type PillMeeting = {
  status: PillMeetingStatus;
  closedMs: number;
  prompt: MeetingPrompt | null;
};

/** Live transcript lines, pushed as they are written so an open meeting view can append them. */
/** Lines appended to a transcript; `revision` is the meeting's `transcriptRevision` after them. */
export type MeetingTranscriptChange = {
  id: MeetingId;
  entries: readonly TranscriptEntry[];
  revision: number;
};

/** What a source said since its last segment, which may still change. Never saved; empty clears it. */
export type MeetingPartial = { id: MeetingId; source: MeetingSource; text: string };

export type MeetingSearchField = "title" | "summary" | "notes" | "transcript";
/** The text around a search match, the match itself kept apart so it can be marked. */
export type MeetingSnippet = { before: string; match: string; after: string };
export type MeetingSearchHit = {
  id: MeetingId;
  field: MeetingSearchField;
  snippet: MeetingSnippet;
};

export const startedAt = (meeting: Meeting): number | null =>
  meeting.spans[0]?.startedAt ??
  (meeting.status.kind === "recording" ? meeting.status.since : null);

export const endedAt = (meeting: Meeting): number | null =>
  meeting.status.kind === "recording" ? null : (meeting.spans.at(-1)?.endedAt ?? null);

/** Recorded audio in ms, leaving out a leg that is still open. */
export const closedMs = (meeting: Meeting) =>
  meeting.spans.reduce((sum, span) => sum + span.endedAt - span.startedAt, 0);

/** Recorded audio in ms, the open leg counted up to `now`. */
export const recordedMs = (meeting: Meeting, now: number): number =>
  closedMs(meeting) +
  (meeting.status.kind === "recording" ? Math.max(0, now - meeting.status.since) : 0);

/** Spec 7: meetings of 5 minutes or less wait for a manual "Generate summary". */
export const AUTO_SUMMARY_MIN_MS = 5 * 60_000;

/** Whether the meeting's recording is long enough to be summarized after Stop without asking. */
export const summarizesOnStop = (meeting: Meeting): boolean =>
  closedMs(meeting) > AUTO_SUMMARY_MIN_MS;

/** True once a resume recorded more than the summary covers, so "Update summary" applies. */
export const summaryStale = (meeting: Meeting): boolean =>
  meeting.summary.kind === "ready" && meeting.summary.summary.coversUntilMs < closedMs(meeting);

export const titleText = (meeting: Meeting) => meeting.title ?? "Untitled meeting";

export const YOU = "You";
export const OTHERS = "Others";

export const speakerDisplayName = (speaker: Speaker) => speaker.name ?? speaker.label;

/** Who spoke a segment: You, a speaker's name or label, or Others before diarization. */
export function speakerName(segment: Segment, speakers: readonly Speaker[]): string {
  if (segment.source === "mic") return YOU;
  const speaker = speakers.find(({ id }) => id === segment.speakerId);
  return speaker ? speakerDisplayName(speaker) : OTHERS;
}

export { SPEAKER_TOKEN, speakerToken } from "@voice/cleanup/summary";

/** The token ids a summary uses besides the meeting's speakers: the user, and voices not told apart. */
export const YOU_ID = "you";
export const OTHERS_ID = "others";

/** The name a summary token stands for; an id the meeting no longer has reads as Others. */
export function tokenName(id: string, speakers: readonly Speaker[]): string {
  if (id === YOU_ID) return YOU;
  const speaker = speakers.find((candidate) => candidate.id === id);
  return speaker ? speakerDisplayName(speaker) : OTHERS;
}

/** Summary Markdown with each speaker token replaced by the name it stands for now. */
export const resolveSpeakerTokens = (markdown: string, speakers: readonly Speaker[]) =>
  markdown.replace(SPEAKER_TOKEN, (_token, id: string) => tokenName(id, speakers));

/** Sets or, when blank, clears the user's name for one speaker. */
export function renameSpeaker(meeting: Meeting, id: SpeakerId, text: string): Meeting {
  const trimmed = text.trim();
  if (!meeting.speakers.some((speaker) => speaker.id === id)) return meeting;
  const speakers = meeting.speakers.map((speaker) =>
    speaker.id === id ? { ...speaker, name: trimmed === "" ? null : trimmed } : speaker,
  );
  return { ...meeting, speakers };
}

/**
 * Speakers for clusters a diarization found, numbered after the meeting's own. A resume after
 * the audio was deleted diarizes only the new audio, so its voices get new speakers.
 */
export function addSpeakers(
  meeting: Meeting,
  count: number,
): { meeting: Meeting; ids: SpeakerId[] } {
  const added = Array.from({ length: count }, (_, index): Speaker => {
    const n = meeting.speakers.length + index + 1;
    return { id: `s${n}` as SpeakerId, label: `Speaker ${n}`, name: null };
  });
  return {
    meeting:
      added.length === 0 ? meeting : { ...meeting, speakers: [...meeting.speakers, ...added] },
    ids: added.map(({ id }) => id),
  };
}

const entryMs = (entry: TranscriptEntry) => (entry.kind === "segment" ? entry.startMs : entry.atMs);

/** Entries in time order, ties in file order: the two sources' lines land out of order. */
export const sortTranscript = (lines: readonly TranscriptEntry[]): TranscriptEntry[] =>
  lines.toSorted((a, b) => entryMs(a) - entryMs(b));

const ruleMatches = (meeting: Meeting, folder: FolderKind): boolean =>
  folder.kind === "auto" &&
  meeting.title !== null &&
  folder.rule.text.trim() !== "" &&
  meeting.title.toLocaleLowerCase().includes(folder.rule.text.trim().toLocaleLowerCase());

export function autoFolderIds(
  meeting: Meeting,
  folders: readonly Folder[],
  settings: MeetingsSettings,
): FolderId[] {
  if (!settings.autoFolders) return [];
  return folders.flatMap((folder) => (ruleMatches(meeting, folder) ? [folder.id] : []));
}

/**
 * Files an existing meeting into `folder` after the folder was made (`before` null), its rule
 * changed, or automatic folders were turned on. A meeting the new rule matches joins; one only
 * the old rule matched leaves; one added by hand stays. Running it twice changes nothing.
 */
export function refile(meeting: Meeting, folder: Folder, before: FolderKind | null): Meeting {
  const inFolder = meeting.folderIds.includes(folder.id);
  if (ruleMatches(meeting, folder)) {
    return inFolder ? meeting : { ...meeting, folderIds: [...meeting.folderIds, folder.id] };
  }
  // A folder turned manual keeps what it holds.
  const left =
    inFolder && folder.kind === "auto" && before !== null && ruleMatches(meeting, before);
  return left
    ? { ...meeting, folderIds: meeting.folderIds.filter((id) => id !== folder.id) }
    : meeting;
}

const SNIPPET_CONTEXT = 40;

const flat = (part: string) => part.replace(/\s+/g, " ");

function snippet(text: string, start: number, end: number): MeetingSnippet {
  const from = Math.max(0, start - SNIPPET_CONTEXT);
  const to = Math.min(text.length, end + SNIPPET_CONTEXT);
  return {
    before: `${from > 0 ? "…" : ""}${flat(text.slice(from, start)).trimStart()}`,
    match: flat(text.slice(start, end)),
    after: `${flat(text.slice(end, to)).trimEnd()}${to < text.length ? "…" : ""}`,
  };
}

// Letters NFD does not take apart, so "lodz" finds "Łódź".
const FOLDED: Record<string, string> = { ł: "l", Ł: "l", ø: "o", Ø: "o", đ: "d", Đ: "d", ß: "ss" };

/** `text` lowercased without accents, and where each of its characters starts in `text`. */
function fold(text: string): { folded: string; from: number[] } {
  let folded = "";
  const from: number[] = [];
  let at = 0;
  for (const char of text) {
    const bare = (FOLDED[char] ?? char.normalize("NFD").replace(/\p{M}/gu, "")).toLocaleLowerCase();
    for (const part of bare) {
      folded += part;
      from.push(at);
    }
    at += char.length;
  }
  from.push(text.length);
  return { folded, from };
}

/** Summary Markdown as it reads on the page: names in, heading marks, bold and bullets out. */
const summaryText = (markdown: string, speakers: readonly Speaker[]) =>
  resolveSpeakerTokens(markdown, speakers)
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*-\s+/gm, "")
    .replaceAll("**", "");

/**
 * The first field, in the order the list shows them, that holds `query`, ignoring case and
 * accents. Transcript lines are searched with the name of whoever said them.
 */
export function searchMeeting(
  meeting: Meeting,
  transcript: readonly TranscriptEntry[],
  query: string,
): MeetingSearchHit | null {
  const needle = fold(query.trim()).folded;
  if (needle === "") return null;
  const summary =
    meeting.summary.kind === "ready"
      ? summaryText(meeting.summary.summary.markdown, meeting.speakers)
      : "";
  const spoken = transcript.flatMap((entry) =>
    entry.kind === "segment" ? [`${speakerName(entry, meeting.speakers)}: ${entry.text}`] : [],
  );
  const fields: [MeetingSearchField, string][] = [
    ["title", meeting.title ?? ""],
    ["summary", summary],
    ["notes", meeting.notes],
    ["transcript", spoken.join("\n")],
  ];
  for (const [field, text] of fields) {
    const { folded, from } = fold(text);
    const at = folded.indexOf(needle);
    if (at < 0) continue;
    return { id: meeting.id, field, snippet: snippet(text, from[at]!, from[at + needle.length]!) };
  }
  return null;
}

/** The user's title, or none when blank, plus the auto folders the new title matches. */
export function retitle(
  meeting: Meeting,
  text: string,
  folders: readonly Folder[],
  settings: MeetingsSettings,
): Meeting {
  const trimmed = text.trim();
  const titled: Meeting = {
    ...meeting,
    title: trimmed === "" ? null : trimmed,
  };
  const added = autoFolderIds(titled, folders, settings).filter(
    (id) => !meeting.folderIds.includes(id),
  );
  return { ...titled, folderIds: [...meeting.folderIds, ...added] };
}

export function parseFolderDraft(raw: unknown): FolderDraft | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { name, kind, rule } = raw as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "") return null;
  if (kind === "manual") return { name, kind };
  if (kind !== "auto" || typeof rule !== "object" || rule === null) return null;
  const { kind: ruleKind, text } = rule as Record<string, unknown>;
  if (ruleKind !== "titleContains" || typeof text !== "string" || text.trim() === "") return null;
  return { name, kind, rule: { kind: ruleKind, text } };
}

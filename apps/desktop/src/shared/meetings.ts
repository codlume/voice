export type MeetingId = string & { readonly __brand: "MeetingId" };
export type FolderId = string & { readonly __brand: "FolderId" };

// Ids name directories under userData, so anything but a UUID is refused before it reaches a path.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const parseMeetingId = (value: unknown): MeetingId | null =>
  typeof value === "string" && UUID.test(value) ? (value as MeetingId) : null;

export const parseFolderId = (value: unknown): FolderId | null =>
  typeof value === "string" && UUID.test(value) ? (value as FolderId) : null;

/** A blank title is null, which lets the summary step generate one. */
export type MeetingTitle = { text: string; source: "user" | "generated" };

/** One recording leg, start to stop or pause, in wall-clock ms. */
export type Span = { startedAt: number; endedAt: number };

/**
 * Where the meeting is in its lifecycle. `starting` remembers what a failed capture start returns
 * to: a new meeting has nothing to keep.
 */
export type MeetingStatus =
  | { kind: "starting"; from: "new" | "paused" | "ready" }
  | { kind: "recording"; since: number }
  | { kind: "paused" }
  | { kind: "finishing" }
  | { kind: "confirmingShort" }
  | { kind: "transcribing" }
  | { kind: "summarizing" }
  | { kind: "ready" };

/** `coversUntilMs` is the recorded length the summary was made from; more recording makes it stale. */
export type Summary = { markdown: string; generatedAt: number; coversUntilMs: number };

export type SummaryState =
  | { kind: "none" }
  | { kind: "ready"; summary: Summary }
  | { kind: "failed"; message: string; previous: Summary | null };

/** What `meeting.json` holds. The transcript lives in its own append-only file. */
export type Meeting = {
  id: MeetingId;
  title: MeetingTitle | null;
  createdAt: number;
  /** Closed legs, oldest first. An open leg is `status.since`. */
  spans: readonly Span[];
  status: MeetingStatus;
  folderIds: readonly FolderId[];
  /** The user's "My thoughts". Summaries never touch it. */
  notes: string;
  summary: SummaryState;
};

/** Transcript times are ms of recorded audio from the meeting's start, pauses left out. */
export type Segment = {
  kind: "segment";
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  /** False for a partial, which a later line with the same id replaces. */
  final: boolean;
} & Voice;

/** The mic is the user. System audio is everyone else, named once a name is known. */
export type Voice = { source: "mic" } | { source: "system"; speaker: string | null };

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

/** Commands later steps build. Until then they answer `unavailable` and change nothing. */
export type MeetingCommandResult = { kind: "unavailable" };

export type MeetingSearchField = "title" | "summary" | "notes" | "transcript";
export type MeetingSearchHit = { id: MeetingId; field: MeetingSearchField; snippet: string };

export const startedAt = (meeting: Meeting): number | null =>
  meeting.spans[0]?.startedAt ??
  (meeting.status.kind === "recording" ? meeting.status.since : null);

export const endedAt = (meeting: Meeting): number | null =>
  meeting.status.kind === "recording" ? null : (meeting.spans.at(-1)?.endedAt ?? null);

const closedMs = (meeting: Meeting) =>
  meeting.spans.reduce((sum, span) => sum + span.endedAt - span.startedAt, 0);

/** Recorded audio in ms, the open leg counted up to `now`. */
export const recordedMs = (meeting: Meeting, now: number): number =>
  closedMs(meeting) +
  (meeting.status.kind === "recording" ? Math.max(0, now - meeting.status.since) : 0);

/** True once a resume recorded more than the summary covers, so "Update summary" applies. */
export const summaryStale = (meeting: Meeting): boolean =>
  meeting.summary.kind === "ready" && meeting.summary.summary.coversUntilMs < closedMs(meeting);

export const titleText = (meeting: Meeting) => meeting.title?.text ?? "Untitled meeting";

export const speakerName = (segment: Segment) =>
  segment.source === "mic" ? "You" : (segment.speaker ?? "Others");

const entryMs = (entry: TranscriptEntry) => (entry.kind === "segment" ? entry.startMs : entry.atMs);

/**
 * The transcript as the file's lines mean it: a later segment with an id replaces the earlier
 * one, and entries run in time order, ties in file order.
 */
export function foldTranscript(lines: readonly TranscriptEntry[]): TranscriptEntry[] {
  const order: (TranscriptEntry | string)[] = [];
  const segments = new Map<string, Segment>();
  for (const line of lines) {
    if (line.kind === "marker") {
      order.push(line);
      continue;
    }
    if (!segments.has(line.id)) order.push(line.id);
    segments.set(line.id, line);
  }
  return order
    .map((item) => (typeof item === "string" ? segments.get(item)! : item))
    .toSorted((a, b) => entryMs(a) - entryMs(b));
}

export function autoFolderIds(
  meeting: Meeting,
  folders: readonly Folder[],
  settings: MeetingsSettings,
): FolderId[] {
  if (!settings.autoFolders || meeting.title === null) return [];
  const title = meeting.title.text.toLocaleLowerCase();
  return folders.flatMap((folder) =>
    folder.kind === "auto" &&
    folder.rule.text.trim() !== "" &&
    title.includes(folder.rule.text.trim().toLocaleLowerCase())
      ? [folder.id]
      : [],
  );
}

const SNIPPET_CONTEXT = 40;

function snippet(text: string, at: number, length: number): string {
  const start = Math.max(0, at - SNIPPET_CONTEXT);
  const end = Math.min(text.length, at + length + SNIPPET_CONTEXT);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

/** The first field, in the order the list shows them, that holds `query`, ignoring case. */
export function searchMeeting(
  meeting: Meeting,
  transcript: readonly TranscriptEntry[],
  query: string,
): MeetingSearchHit | null {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return null;
  const summary = meeting.summary.kind === "ready" ? meeting.summary.summary.markdown : "";
  const spoken = transcript.flatMap((entry) => (entry.kind === "segment" ? [entry.text] : []));
  const fields: [MeetingSearchField, string][] = [
    ["title", meeting.title?.text ?? ""],
    ["summary", summary],
    ["notes", meeting.notes],
    ["transcript", spoken.join("\n")],
  ];
  for (const [field, text] of fields) {
    const at = text.toLocaleLowerCase().indexOf(needle);
    if (at >= 0) return { id: meeting.id, field, snippet: snippet(text, at, needle.length) };
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
    title: trimmed === "" ? null : { text: trimmed, source: "user" },
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

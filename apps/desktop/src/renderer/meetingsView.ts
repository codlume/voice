import { dayKey, type DayKey } from "../shared/insights.ts";
import { clock, markerText } from "../shared/meeting-markdown.ts";
import {
  endedAt,
  meetingRetentionMs,
  sortTranscript,
  OTHERS,
  YOU,
  SPEAKER_TOKEN,
  speakerDisplayName,
  speakerName,
  startedAt,
  tokenName,
  type MaxLength,
  type Meeting,
  type MeetingRetention,
  type MeetingSearchField,
  type MeetingSearchHit,
  type MeetingSource,
  type MeetingStatus,
  type Speaker,
  type TranscriptEntry,
} from "../shared/meetings.ts";
import { dayLabel, formatterCache, timeLabel } from "./historyView.ts";

/** When the meeting began, or when it was made if it never recorded. */
/** Shown where a first meeting starts: the setup checklist and the notepad before anyone speaks. */
export const CONSENT_REMINDER = "Always get consent before recording others.";

export const meetingAt = (meeting: Meeting) => startedAt(meeting) ?? meeting.createdAt;

export type MeetingDay = { day: DayKey; label: string; meetings: readonly Meeting[] };

/** Meetings arrive newest first, so the days come out newest first too. */
export function meetingDays(
  meetings: readonly Meeting[],
  today: DayKey,
  locale?: string,
): MeetingDay[] {
  const days = Map.groupBy(meetings, (meeting) => dayKey(new Date(meetingAt(meeting))));
  return Array.from(days, ([day, dayMeetings]) => ({
    day,
    label: dayLabel(day, today, locale),
    meetings: dayMeetings,
  }));
}

const shortDate = formatterCache({ weekday: "short", month: "short", day: "numeric" });

/** "Thu, Oct 22 · 5:28 PM", the line under a meeting's title. */
export function meetingWhen(meeting: Meeting, locale?: string): string {
  const at = meetingAt(meeting);
  return `${shortDate(locale).format(at)} · ${timeLabel(at, locale)}`;
}

export function durationLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "Under a minute";
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes} min`;
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

const statusLabels: Record<MeetingStatus["kind"], string | null> = {
  starting: "Starting…",
  recording: "Recording",
  paused: "Paused",
  finishing: "Finishing…",
  confirmingShort: "Short recording",
  transcribing: "Transcribing…",
  summarizing: "Writing summary…",
  ready: null,
};

/** A word for a row whose meeting is not done yet. */
export const statusLabel = (meeting: Meeting) => statusLabels[meeting.status.kind];

// Summary Markdown, limited to what the summary step writes: headings, paragraphs, and bullet
// lists one level deep, with **bold** inline.

/** `line` is where the text starts in the Markdown, which keys it when rendered. */
export type Line = { line: number; text: string };
export type ListItem = Line & { children: Line[] };
export type Block =
  | ({ kind: "heading"; level: number } & Line)
  | ({ kind: "paragraph" } & Line)
  | { kind: "list"; line: number; items: ListItem[] };

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;

export function summaryBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: Line | null = null;
  const endParagraph = () => {
    if (paragraph) blocks.push({ kind: "paragraph", ...paragraph });
    paragraph = null;
  };
  for (const [line, raw] of markdown.split("\n").entries()) {
    const heading = HEADING.exec(raw);
    const bullet = BULLET.exec(raw);
    if (raw.trim() === "") {
      endParagraph();
    } else if (heading) {
      endParagraph();
      blocks.push({ kind: "heading", level: heading[1]!.length, line, text: heading[2]!.trim() });
    } else if (bullet) {
      endParagraph();
      const indent = bullet[1]!;
      const text = bullet[2]!.trim();
      const last = blocks.at(-1);
      const list = last?.kind === "list" ? last : { kind: "list" as const, line, items: [] };
      if (list !== last) blocks.push(list);
      const parent = list.items.at(-1);
      if (indent.length >= 2 && parent) parent.children.push({ line, text });
      else list.items.push({ line, text, children: [] });
    } else if (paragraph) {
      paragraph.text = `${paragraph.text} ${raw.trim()}`;
    } else {
      paragraph = { line, text: raw.trim() };
    }
  }
  endParagraph();
  return blocks;
}

/**
 * The paragraph a summary opens with, which the side panel shows as the overview. A summary that
 * opens with a heading has none: its first paragraph further down is an owner's name.
 */
export function overview(markdown: string): string | null {
  const [first] = summaryBlocks(markdown);
  return first?.kind === "paragraph" ? first.text : null;
}

/** `at` is the run's offset in the source text, which keys it when rendered. */
export type Run = { text: string; bold: boolean; name: boolean; at: number };

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function nameRuns(text: string, bold: boolean, start: number, pattern: RegExp | null): Run[] {
  if (!pattern) return text === "" ? [] : [{ text, bold, name: false, at: start }];
  let at = start;
  return text.split(pattern).flatMap((part, index) => {
    const run = { text: part, bold, name: index % 2 === 1, at };
    at += part.length;
    return part === "" ? [] : [run];
  });
}

// The token pattern without the global flag, whose `lastIndex` a shared regex would carry over.
const speakerTokens = new RegExp(SPEAKER_TOKEN.source);

function speakerRuns(
  text: string,
  bold: boolean,
  start: number,
  pattern: RegExp | null,
  speakers: readonly Speaker[],
): Run[] {
  let at = start;
  return text.split(speakerTokens).flatMap((part, index) => {
    const from = at;
    if (index % 2 === 0) {
      at += part.length;
      return nameRuns(part, bold, from, pattern);
    }
    at += `{{speaker:${part}}}`.length;
    return [{ text: tokenName(part, speakers), bold, name: true, at: from }];
  });
}

/**
 * Inline summary text as runs: **bold** spans and the speakers to highlight. A speaker token
 * shows the speaker's current name; a name written out matches as a whole word, so "Ann" does
 * not light up inside "Annual".
 */
export function inlineRuns(text: string, speakers: readonly Speaker[]): Run[] {
  const names = speakers.map(speakerDisplayName);
  const sorted = names.filter((name) => name.trim() !== "").toSorted((a, b) => b.length - a.length);
  const pattern =
    sorted.length > 0
      ? new RegExp(
          `(?<![\\p{L}\\p{N}])(${sorted.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`,
          "u",
        )
      : null;
  let at = 0;
  return text.split(/\*\*(.+?)\*\*/).flatMap((part, index) => {
    const bold = index % 2 === 1;
    const start = at + (bold ? 2 : 0);
    at += part.length + (bold ? 4 : 0);
    return speakerRuns(part, bold, start, pattern, speakers);
  });
}

export type TranscriptRow =
  | {
      kind: "speech";
      id: string;
      speaker: string;
      mine: boolean;
      time: string;
      text: string;
      final: boolean;
      /** True when the same voice spoke the row before, so the label is left out. */
      continues: boolean;
    }
  | { kind: "marker"; id: string; text: string };

export function transcriptRows(
  lines: readonly TranscriptEntry[],
  speakers: readonly Speaker[],
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let lastSpeaker: string | null = null;
  for (const [index, entry] of sortTranscript(lines).entries()) {
    if (entry.kind === "marker") {
      rows.push({
        kind: "marker",
        id: `marker-${index}`,
        text: `${markerText[entry.marker]} at ${clock(entry.atMs)}`,
      });
      lastSpeaker = null;
      continue;
    }
    const speaker = speakerName(entry, speakers);
    rows.push({
      kind: "speech",
      id: entry.id,
      speaker,
      mine: entry.source === "mic",
      time: clock(entry.startMs),
      text: entry.text,
      final: true,
      continues: speaker === lastSpeaker,
    });
    lastSpeaker = speaker;
  }
  return rows;
}

/**
 * Unconfirmed text as gray rows after the transcript, the user's first. The other side is
 * Others: speakers are told apart only after Stop.
 */
export function partialRows(partials: Partial<Record<MeetingSource, string>>): TranscriptRow[] {
  return (["mic", "system"] as const).flatMap((source) => {
    const text = partials[source]?.trim();
    if (!text) return [];
    const mine = source === "mic";
    const speaker = mine ? YOU : OTHERS;
    return [
      {
        kind: "speech",
        id: `partial-${source}`,
        speaker,
        mine,
        time: "",
        text,
        final: false,
        continues: false,
      },
    ];
  });
}

const hitLabels: Record<MeetingSearchField, string | null> = {
  title: null,
  summary: "Summary",
  notes: "My thoughts",
  transcript: "Transcript",
};

export type SearchResult = { meeting: Meeting; where: string | null; snippet: string };

/** Hits in main's order, paired with their meetings; a hit for a meeting just deleted drops out. */
export function searchResults(
  meetings: readonly Meeting[],
  hits: readonly MeetingSearchHit[],
): SearchResult[] {
  const byId = new Map(meetings.map((meeting) => [meeting.id, meeting]));
  return hits.flatMap(({ id, field, snippet }) => {
    const meeting = byId.get(id);
    return meeting ? [{ meeting, where: hitLabels[field], snippet }] : [];
  });
}

export const maxLengthLabels: Record<MaxLength, string> = {
  "30m": "30 minutes",
  "1h": "1 hour",
  "2h": "2 hours",
  "3h": "3 hours",
};

export const retentionLabels: Record<MeetingRetention, string> = {
  day: "24 hours",
  week: "7 days",
  month: "30 days",
  quarter: "90 days",
  halfYear: "6 months",
  year: "1 year",
  forever: "Forever",
};

/** How long meetings stay, in one sentence the settings show under the choice. */
export function retentionSentence(retention: MeetingRetention): string {
  const kept =
    retention === "forever"
      ? "Transcripts, summaries and your thoughts stay on this Mac until you delete them."
      : `Transcripts, summaries and your thoughts stay on this Mac for ${retentionLabels[retention]}, then they are deleted.`;
  return `${kept} Meeting audio is deleted once the transcript is done.`;
}

/** How many finished meetings a shorter retention deletes at `now`, counted the way main expires them. */
export function expiredBy(
  meetings: readonly Meeting[],
  retention: MeetingRetention,
  now: number,
): number {
  return meetings.filter(
    (meeting) =>
      meeting.status.kind === "ready" &&
      (endedAt(meeting) ?? meeting.createdAt) + meetingRetentionMs[retention] <= now,
  ).length;
}

import {
  foldTranscript,
  speakerName,
  startedAt,
  titleText,
  type Marker,
  type Meeting,
  type MarkerKind,
  type TranscriptEntry,
} from "./meetings.ts";

export const markerText: Record<MarkerKind, string> = {
  paused: "Paused",
  resumed: "Resumed",
  dictated: "Dictated",
  gap: "Audio lost",
};

const pad = (value: number) => String(value).padStart(2, "0");

export function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutesSeconds = `${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
  return hours > 0 ? `${hours}:${minutesSeconds}` : minutesSeconds;
}

const markerLine = ({ marker, atMs }: Marker) => `*${markerText[marker]} at ${clock(atMs)}*`;

/**
 * The whole meeting as Markdown, for "Copy as Markdown" and "Export .md": title, date, summary,
 * My thoughts, then the transcript. Empty sections are left out.
 */
export function meetingMarkdown(
  meeting: Meeting,
  transcript: readonly TranscriptEntry[],
  format: { locale?: string; timeZone?: string } = {},
): string {
  const sections = [`# ${titleText(meeting)}`];
  const at = startedAt(meeting) ?? meeting.createdAt;
  sections.push(
    new Intl.DateTimeFormat(format.locale, {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: format.timeZone,
    }).format(at),
  );
  if (meeting.summary.kind === "ready") {
    sections.push(`## Summary\n\n${meeting.summary.summary.markdown.trim()}`);
  }
  if (meeting.notes.trim() !== "") sections.push(`## My thoughts\n\n${meeting.notes.trim()}`);
  const lines = foldTranscript(transcript).flatMap((entry) => {
    if (entry.kind === "marker") return [markerLine(entry)];
    const text = entry.text.trim();
    return text === "" ? [] : [`**${speakerName(entry)}** (${clock(entry.startMs)}): ${text}`];
  });
  if (lines.length > 0) sections.push(`## Transcript\n\n${lines.join("\n\n")}`);
  return `${sections.join("\n\n")}\n`;
}

import { clock } from "../shared/meeting-markdown.ts";
import {
  recordedMs,
  type Meeting,
  type MeetingPrompt,
  type TranscriptEntry,
} from "../shared/meetings.ts";

export type RecordingCommand = "pause" | "resume" | "stop";
export type NotepadCommand = RecordingCommand | "keep" | "discard" | "dismiss";

/** `recording` is the only tone that says audio is being captured. */
export type NotepadStatus = {
  tone: "recording" | "paused" | "busy" | "done";
  label: string;
  clock: string;
  /** The recording controls this status offers, in order. */
  controls: readonly RecordingCommand[];
};

const labels: Record<Meeting["status"]["kind"], Omit<NotepadStatus, "clock">> = {
  starting: { tone: "busy", label: "Starting…", controls: ["stop"] },
  recording: { tone: "recording", label: "Recording", controls: ["pause", "stop"] },
  paused: { tone: "paused", label: "Paused", controls: ["resume", "stop"] },
  finishing: { tone: "busy", label: "Wrapping up…", controls: [] },
  confirmingShort: { tone: "busy", label: "Short recording", controls: [] },
  transcribing: { tone: "busy", label: "Transcribing…", controls: [] },
  summarizing: { tone: "done", label: "Saved to Meetings", controls: [] },
  ready: { tone: "done", label: "Saved to Meetings", controls: [] },
};

export function notepadStatus(meeting: Meeting, now: number): NotepadStatus {
  return { ...labels[meeting.status.kind], clock: clock(recordedMs(meeting, now)) };
}

export type PromptAction = { label: string; command: NotepadCommand; primary: boolean };
export type PromptView = { title: string | null; body: string; actions: readonly PromptAction[] };

const MINUTE_MS = 60_000;

export function promptView(prompt: MeetingPrompt, now: number): PromptView {
  switch (prompt.kind) {
    case "startedByMistake":
      return {
        title: "Started by mistake?",
        body: "Only a few words were captured. Keep this meeting or discard it.",
        actions: [
          { label: "Discard", command: "discard", primary: false },
          { label: "Keep", command: "keep", primary: true },
        ],
      };
    case "silence":
      return {
        title: "Still in a meeting?",
        body: "Voice has not heard anyone for 10 minutes.",
        actions: [
          { label: "Stop", command: "stop", primary: false },
          { label: "Keep recording", command: "dismiss", primary: true },
        ],
      };
    case "maxLengthSoon": {
      const minutes = Math.max(1, Math.ceil((prompt.endsAt - now) / MINUTE_MS));
      return {
        title: "Approaching the time limit",
        body: `Recording stops in ${minutes} min, at the maximum length set in Meetings.`,
        actions: [
          { label: "End recording", command: "stop", primary: false },
          { label: "Dismiss", command: "dismiss", primary: true },
        ],
      };
    }
    case "notice":
      return {
        title: null,
        body: prompt.text,
        actions: [{ label: "Dismiss", command: "dismiss", primary: false }],
      };
  }
}

/** The clock moves only while the meeting records or counts down to its maximum length. */
export const notepadTicks = (meeting: Meeting, prompt: MeetingPrompt | null) =>
  meeting.status.kind === "recording" || prompt?.kind === "maxLengthSoon";

const key = (entry: TranscriptEntry) => JSON.stringify(entry);

/**
 * The transcript read from main plus the live lines that arrived while it loaded. A live line the
 * read already holds is left out, so a marker is not doubled and a partial does not come back
 * after its final line.
 */
export function mergeTranscript(
  read: readonly TranscriptEntry[],
  live: readonly TranscriptEntry[],
): TranscriptEntry[] {
  const seen = new Set(read.map(key));
  return [...read, ...live.filter((entry) => !seen.has(key(entry)))];
}

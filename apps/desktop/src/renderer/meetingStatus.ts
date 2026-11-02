import { clock } from "../shared/meeting-markdown.ts";
import {
  recordedMs,
  type Meeting,
  type MeetingCommandResult,
  type MeetingPrompt,
  type MeetingStatus,
} from "../shared/meetings.ts";

export type RecordingCommand = "pause" | "resume" | "stop";
export type PromptCommand = RecordingCommand | "keep" | "discard" | "dismiss" | "viewSummary";

/**
 * How every surface names a status and which recording controls it offers. `recording` is the
 * only tone that says audio is being captured.
 */
export type StatusView = {
  tone: "recording" | "paused" | "busy" | "done";
  label: string;
  /** In order. */
  controls: readonly RecordingCommand[];
};

const statusViews: Record<MeetingStatus["kind"], StatusView> = {
  starting: { tone: "busy", label: "Starting…", controls: ["stop"] },
  recording: { tone: "recording", label: "Recording", controls: ["pause", "stop"] },
  paused: { tone: "paused", label: "Paused", controls: ["resume", "stop"] },
  finishing: { tone: "busy", label: "Wrapping up…", controls: [] },
  confirmingShort: { tone: "busy", label: "Short recording", controls: [] },
  transcribing: { tone: "busy", label: "Transcribing…", controls: [] },
  // Resume appends to the same meeting; a summary being written stops and can be updated after.
  summarizing: { tone: "done", label: "Writing summary…", controls: ["resume"] },
  ready: { tone: "done", label: "Saved to Meetings", controls: ["resume"] },
};

export const statusView = (status: Pick<MeetingStatus, "kind">): StatusView =>
  statusViews[status.kind];

/** The status word beside a meeting that is not done yet; a ready meeting needs none. */
export const statusLabel = (meeting: Meeting): string | null =>
  meeting.status.kind === "ready" ? null : statusViews[meeting.status.kind].label;

export const statusClock = (meeting: Meeting, now: number) => clock(recordedMs(meeting, now));

/** The clock moves only while the meeting records or counts down to its maximum length. */
export const clockTicks = (status: Pick<MeetingStatus, "kind">, prompt: MeetingPrompt | null) =>
  status.kind === "recording" || prompt?.kind === "maxLengthSoon";

const MINUTE_MS = 60_000;

export const minutesLeft = (endsAt: number, now: number) =>
  Math.max(1, Math.ceil((endsAt - now) / MINUTE_MS));

/** Why a command did nothing, in words for the user, or null when it went ahead. */
export const commandRefusal = (result: MeetingCommandResult) =>
  result.kind === "refused" ? result.message : null;

export const promptTitles = {
  startedByMistake: "Started by mistake?",
  silence: "Still in a meeting?",
  maxLengthSoon: "Approaching the time limit",
  summaryReady: "Your summary is ready",
} as const;

export type PromptAction = { label: string; command: PromptCommand; primary: boolean };
export type PromptView = { title: string | null; body: string; actions: readonly PromptAction[] };

export function promptView(prompt: MeetingPrompt, now: number): PromptView {
  switch (prompt.kind) {
    case "startedByMistake":
      return {
        title: promptTitles.startedByMistake,
        body: "Only a few words were captured. Keep this meeting or discard it.",
        actions: [
          { label: "Discard", command: "discard", primary: false },
          { label: "Keep", command: "keep", primary: true },
        ],
      };
    case "silence":
      return {
        title: promptTitles.silence,
        body: "Voice has not heard anyone for 10 minutes. Recording stops in 30 seconds.",
        actions: [
          { label: "Stop", command: "stop", primary: false },
          { label: "Keep recording", command: "dismiss", primary: true },
        ],
      };
    case "maxLengthSoon":
      return {
        title: promptTitles.maxLengthSoon,
        body: `Recording stops in ${minutesLeft(prompt.endsAt, now)} min, at the maximum length set in Meetings.`,
        actions: [
          { label: "End recording", command: "stop", primary: false },
          { label: "Dismiss", command: "dismiss", primary: true },
        ],
      };
    case "summaryReady":
      return {
        title: promptTitles.summaryReady,
        body: "The summary of this meeting is in Voice.",
        actions: [
          { label: "Dismiss", command: "dismiss", primary: false },
          { label: "View summary", command: "viewSummary", primary: true },
        ],
      };
    case "notice":
      return {
        title: null,
        body: prompt.text,
        actions: [{ label: "Dismiss", command: "dismiss", primary: false }],
      };
  }
}

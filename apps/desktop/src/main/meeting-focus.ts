import {
  closedMs,
  type AudioLoss,
  type Meeting,
  type MeetingId,
  type MeetingNotice,
  type MeetingPrompt,
  type PillMeeting,
  type PillMeetingStatus,
} from "../shared/meetings.ts";

/**
 * The meeting the Flow Bar and the notepad follow, and the last prompt a notice raised, which
 * stays until the user answers it or it no longer applies.
 */
export type MeetingFocus = {
  current: CurrentMeeting | null;
  raised: { id: MeetingId; prompt: MeetingPrompt } | null;
};

export const noMeetingFocus: MeetingFocus = { current: null, raised: null };

export type CurrentMeeting = Meeting & { status: PillMeetingStatus };

// A capture comes first, then an answer the user owes, then a meeting they can resume.
const rank: Record<PillMeetingStatus["kind"], number> = {
  starting: 0,
  recording: 0,
  confirmingShort: 1,
  finishing: 2,
  paused: 3,
};

const isCurrent = (meeting: Meeting): meeting is CurrentMeeting => meeting.status.kind in rank;

/** Meetings arrive newest first, so a tie goes to the newest. */
export function currentMeeting(meetings: readonly Meeting[]): CurrentMeeting | null {
  let best: CurrentMeeting | null = null;
  for (const meeting of meetings) {
    if (!isCurrent(meeting)) continue;
    if (best === null || rank[meeting.status.kind] < rank[best.status.kind]) best = meeting;
  }
  return best;
}

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

const noticeText: Partial<Record<MeetingNotice["kind"], string>> = {
  maxLengthReached: "Recording stopped at the maximum length.",
  atMaxLength: "This meeting is at its maximum length and cannot record more.",
};

/**
 * The prompt a notice raises where the user is. A failed start leaves no meeting to show it on,
 * and summary outcomes belong to the Voice window.
 */
export function noticePrompt(notice: MeetingNotice, now: number): MeetingPrompt | null {
  switch (notice.kind) {
    case "silence":
      return { kind: "silence" };
    case "maxLengthSoon":
      return { kind: "maxLengthSoon", endsAt: now + notice.inMs };
    case "resumeFailed":
      return { kind: "notice", text: notice.message };
    case "captureLost":
      return { kind: "notice", text: lostText(notice.loss) };
    default: {
      const text = noticeText[notice.kind];
      return text ? { kind: "notice", text } : null;
    }
  }
}

// Silence and the length warning are about a capture that is running; any other status ends them.
function stillApplies(prompt: MeetingPrompt, meeting: Meeting): boolean {
  if (prompt.kind === "silence" || prompt.kind === "maxLengthSoon") {
    return meeting.status.kind === "recording";
  }
  return meeting.status.kind !== "recording" && meeting.status.kind !== "starting";
}

/** Follows the meetings: picks the current one and drops a prompt that stopped applying. */
export function follow(focus: MeetingFocus, meetings: readonly Meeting[]): MeetingFocus {
  const current = currentMeeting(meetings);
  const { raised } = focus;
  const meeting = raised && meetings.find(({ id }) => id === raised.id);
  const kept = raised && meeting && stillApplies(raised.prompt, meeting) ? raised : null;
  if (current === focus.current && kept === raised) return focus;
  return { current, raised: kept };
}

export function raise(
  focus: MeetingFocus,
  id: MeetingId,
  notice: MeetingNotice,
  now: number,
): MeetingFocus {
  const prompt = noticePrompt(notice, now);
  return prompt ? { ...focus, raised: { id, prompt } } : focus;
}

export const dismiss = (focus: MeetingFocus): MeetingFocus =>
  focus.raised ? { ...focus, raised: null } : focus;

/** "Started by mistake?" holds the meeting, so it comes before anything a notice raised. */
export function promptFor(meeting: Meeting, focus: MeetingFocus): MeetingPrompt | null {
  if (meeting.status.kind === "confirmingShort") return { kind: "startedByMistake" };
  return focus.raised?.id === meeting.id ? focus.raised.prompt : null;
}

export function toPillMeeting(focus: MeetingFocus): PillMeeting | null {
  const { current } = focus;
  if (!current) return null;
  return {
    status: current.status,
    closedMs: closedMs(current),
    prompt: promptFor(current, focus),
  };
}

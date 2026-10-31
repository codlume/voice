import {
  closedMs,
  noticeText,
  type Meeting,
  type MeetingBanner,
  type MeetingId,
  type MeetingNotice,
  type MeetingPrompt,
  type PillMeeting,
  type PillMeetingStatus,
} from "../shared/meetings.ts";

/**
 * The meeting the Flow Bar and the notepad follow, the last prompt a notice raised, and the
 * notices the Meetings page shows, newest first. Each stays until the user dismisses it or it no
 * longer applies; dismissing a notice in one place dismisses it in the other.
 */
export type MeetingFocus = {
  current: CurrentMeeting | null;
  raised: { id: MeetingId; prompt: MeetingPrompt; key: number | null } | null;
  banners: readonly Banner[];
  nextKey: number;
};

type Banner = MeetingBanner & { kind: MeetingNotice["kind"] };

export const noMeetingFocus: MeetingFocus = {
  current: null,
  raised: null,
  banners: [],
  nextKey: 1,
};

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

/**
 * The prompt a notice raises where the user is. A failed start leaves no meeting to show it on,
 * and the final pass and summary outcomes belong to the Voice window.
 */
export function noticePrompt(notice: MeetingNotice, now: number): MeetingPrompt | null {
  switch (notice.kind) {
    case "silence":
      return { kind: "silence" };
    case "maxLengthSoon":
      return { kind: "maxLengthSoon", endsAt: now + notice.inMs };
    case "resumeFailed":
    case "captureLost":
    case "maxLengthReached":
    case "atMaxLength": {
      const text = noticeText(notice);
      return text === null ? null : { kind: "notice", text };
    }
    default:
      return null;
  }
}

// Silence and the length warning are about a capture that is running; any other status ends them.
function stillApplies(prompt: MeetingPrompt, meeting: Meeting): boolean {
  if (prompt.kind === "silence" || prompt.kind === "maxLengthSoon") {
    return meeting.status.kind === "recording";
  }
  return !isLive(meeting);
}

// A failed start has no meeting; it is moot once one records. A failed summary goes once it is
// tried again, and a failed final pass stays.
function stillShown(banner: Banner, meetings: readonly Meeting[]): boolean {
  if (banner.kind === "startFailed") return !meetings.some(isLive);
  const meeting = meetings.find(({ id }) => id === banner.id);
  if (!meeting) return false;
  switch (banner.kind) {
    case "finalPassFailed":
      return true;
    case "summaryFailed":
      return meeting.summary.kind === "failed" && meeting.status.kind !== "summarizing";
    default:
      return !isLive(meeting);
  }
}

const isLive = ({ status }: Meeting) => status.kind === "recording" || status.kind === "starting";

/** Follows the meetings: picks the current one and drops prompts and notices that stopped applying. */
export function follow(focus: MeetingFocus, meetings: readonly Meeting[]): MeetingFocus {
  const current = currentMeeting(meetings);
  const { raised } = focus;
  const meeting = raised && meetings.find(({ id }) => id === raised.id);
  const kept = raised && meeting && stillApplies(raised.prompt, meeting) ? raised : null;
  const banners = focus.banners.filter((banner) => stillShown(banner, meetings));
  if (current === focus.current && kept === raised && banners.length === focus.banners.length) {
    return focus;
  }
  return { ...focus, current, raised: kept, banners };
}

export function raise(
  focus: MeetingFocus,
  id: MeetingId,
  notice: MeetingNotice,
  now: number,
): MeetingFocus {
  const prompt = noticePrompt(notice, now);
  const text = noticeText(notice);
  if (text === null) return prompt ? { ...focus, raised: { id, prompt, key: null } } : focus;
  const key = focus.nextKey;
  const others = focus.banners.filter((banner) => banner.id !== id || banner.kind !== notice.kind);
  return {
    ...focus,
    raised: prompt ? { id, prompt, key } : focus.raised,
    banners: [{ key, id, kind: notice.kind, text }, ...others],
    nextKey: key + 1,
  };
}

/** Answers the notepad's prompt, and takes the notice it came from off the Meetings page. */
export const dismiss = (focus: MeetingFocus): MeetingFocus =>
  focus.raised ? dismissBanner(focus, focus.raised.key) : focus;

/** Takes a notice off the Meetings page and the notepad; null is a prompt with no notice. */
export function dismissBanner(focus: MeetingFocus, key: number | null): MeetingFocus {
  const raised = focus.raised && (key === null || focus.raised.key === key) ? null : focus.raised;
  const banners = key === null ? focus.banners : focus.banners.filter((b) => b.key !== key);
  if (raised === focus.raised && banners.length === focus.banners.length) return focus;
  return { ...focus, raised, banners };
}

export const meetingBanners = (focus: MeetingFocus): MeetingBanner[] =>
  focus.banners.map(({ key, id, text }) => ({ key, id, text }));

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

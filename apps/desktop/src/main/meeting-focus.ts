import {
  closedMs,
  isCapturing,
  isLive,
  noticeText,
  type Meeting,
  type MeetingBanner,
  type MeetingId,
  type MeetingNotice,
  type MeetingNoticeAction,
  type MeetingPrompt,
  type PillMeeting,
  type PillMeetingStatus,
} from "../shared/meetings.ts";

export type MeetingFocus = {
  current: CurrentMeeting | null;
  raised: Raised | null;
  banners: readonly Banner[];
  nextKey: number;
};

type Raised = {
  id: MeetingId;
  prompt: MeetingPrompt;
  key: number | null;
  noticeKind: MeetingNotice["kind"];
};

type Banner = MeetingBanner & { kind: MeetingNotice["kind"] };

export const noMeetingFocus: MeetingFocus = {
  current: null,
  raised: null,
  banners: [],
  nextKey: 1,
};

type CurrentMeeting = Meeting & { status: PillMeetingStatus };

const rank: Record<PillMeetingStatus["kind"], number> = {
  starting: 0,
  recording: 0,
  confirmingShort: 1,
  finishing: 2,
  paused: 3,
};

const isCurrent = (meeting: Meeting): meeting is CurrentMeeting => meeting.status.kind in rank;

export function currentMeeting(meetings: readonly Meeting[]): CurrentMeeting | null {
  let best: CurrentMeeting | null = null;
  for (const meeting of meetings) {
    if (!isCurrent(meeting)) continue;
    if (best === null || rank[meeting.status.kind] < rank[best.status.kind]) best = meeting;
  }
  return best;
}

export function noticePrompt(notice: MeetingNotice, now: number): MeetingPrompt | null {
  switch (notice.kind) {
    case "silence":
      return { kind: "silence" };
    case "maxLengthSoon":
      return { kind: "maxLengthSoon", endsAt: now + notice.inMs };
    case "summaryReady":
      return { kind: "summaryReady" };
    case "resumeFailed":
    case "captureLost":
    case "systemAudioMissing":
    case "maxLengthReached":
    case "atMaxLength": {
      const text = noticeText(notice);
      return text === null ? null : { kind: "notice", text };
    }
    default:
      return null;
  }
}

function stillApplies(raised: Raised, meeting: Meeting): boolean {
  switch (raised.noticeKind) {
    case "silence":
    case "maxLengthSoon":
    case "systemAudioMissing":
      return meeting.status.kind === "recording";
    default:
      return !isCapturing(meeting);
  }
}

function stillShown(banner: Banner, meetings: readonly Meeting[]): boolean {
  if (banner.kind === "startFailed") return !meetings.some(isCapturing);
  const meeting = meetings.find(({ id }) => id === banner.id);
  if (!meeting) return false;
  switch (banner.kind) {
    case "systemAudioMissing":
      return meeting.status.kind === "recording";
    case "restartBlocked":
      return isLive(meeting);
    case "finalPassFailed":
      return meeting.finalPassFailed !== null;
    case "audioDeleteFailed":
      return meeting.audio === "deleting";
    case "summaryFailed":
      return meeting.summary.kind === "failed" && meeting.status.kind !== "summarizing";
    case "summaryReady":
      return meeting.summary.kind === "ready" && meeting.status.kind === "ready";
    default:
      return !isCapturing(meeting);
  }
}

export function follow(focus: MeetingFocus, meetings: readonly Meeting[]): MeetingFocus {
  const current = currentMeeting(meetings);
  const { raised } = focus;
  const meeting = raised && meetings.find(({ id }) => id === raised.id);
  const kept = raised && meeting && stillApplies(raised, meeting) ? raised : null;
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
  const raised = (key: number | null) => prompt && { id, prompt, key, noticeKind: notice.kind };
  if (text === null) return prompt ? { ...focus, raised: raised(null) } : focus;
  const key = focus.nextKey;
  const others = focus.banners.filter((banner) => banner.id !== id || banner.kind !== notice.kind);
  const banner: Banner = {
    key,
    id,
    kind: notice.kind,
    text,
    actions: noticeActions(notice),
    dismissable: notice.kind !== "finalPassFailed" && notice.kind !== "audioDeleteFailed",
  };
  return {
    ...focus,
    raised: raised(key) ?? focus.raised,
    banners: [banner, ...others],
    nextKey: key + 1,
  };
}

function noticeActions(notice: MeetingNotice): readonly MeetingNoticeAction[] {
  switch (notice.kind) {
    case "finalPassFailed":
      return ["retryFinalPass", "deleteAudio"];
    case "audioDeleteFailed":
      return ["deleteAudio"];
    case "summaryReady":
      return ["viewSummary"];
    default:
      return [];
  }
}

export const dismiss = (focus: MeetingFocus): MeetingFocus =>
  focus.raised ? dismissBanner(focus, focus.raised.key) : focus;

export function dismissBanner(focus: MeetingFocus, key: number | null): MeetingFocus {
  const raised = focus.raised && (key === null || focus.raised.key === key) ? null : focus.raised;
  const banners = key === null ? focus.banners : focus.banners.filter((b) => b.key !== key);
  if (raised === focus.raised && banners.length === focus.banners.length) return focus;
  return { ...focus, raised, banners };
}

const asBanner = ({ kind: _kind, ...banner }: Banner): MeetingBanner => banner;

export const meetingBanners = (focus: MeetingFocus): MeetingBanner[] =>
  focus.banners.filter(({ kind }) => kind !== "restartBlocked").map(asBanner);

export function restartNotice(focus: MeetingFocus): MeetingBanner | null {
  const banner = focus.banners.find(({ kind }) => kind === "restartBlocked");
  return banner ? asBanner(banner) : null;
}

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

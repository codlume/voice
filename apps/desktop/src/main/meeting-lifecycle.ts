import {
  maxLengthMs,
  recordedMs,
  summarizesOnStop,
  type AudioLoss,
  type FinalPassFailure,
  type MarkerKind,
  type MaxLength,
  type Meeting,
  type MeetingId,
  type MeetingNotice,
  type MeetingStatus,
  type MeetingsSettings,
  type SummaryProgress,
} from "../shared/meetings.ts";
import type { FinalSegment } from "./meeting-final-pass.ts";

export type LifecycleConfig = Pick<
  MeetingsSettings,
  "maxLength" | "silencePrompt" | "openSummaryWhenReady"
>;

export type Timer = "maxLengthWarning" | "maxLength" | "silenceStop";

export type Watch = "start" | "drain" | "finalPass";

export type MeetingEvent =
  | { type: "start"; id: MeetingId }
  | { type: "resume" }
  | { type: "captureStarted"; leg: number }
  | { type: "captureFailed"; leg: number; message: string }
  | { type: "captureLost"; leg: number; loss: AudioLoss }
  | { type: "systemAudioMissing"; leg: number; reason: AudioLoss["reason"] }
  | { type: "pause" }
  | { type: "stop" }
  | { type: "timer"; leg: number; timer: Timer }
  | { type: "silence"; leg: number }
  | { type: "drained"; words: number }
  | { type: "finalPass"; segments: readonly FinalSegment[] }
  | { type: "finalized" }
  | { type: "finalizeFailed"; reason: FinalPassFailure }
  | { type: "stalled"; watch: Watch }
  | { type: "helperReady" }
  | { type: "helperExited" }
  | { type: "keep" }
  | { type: "discard" }
  | { type: "delete" }
  | { type: "retryFinalPass" }
  | { type: "deleteAudio" }
  | { type: "audioDeleteFailed" }
  | { type: "generateSummary" }
  | { type: "summaryProgress"; progress: SummaryProgress }
  | { type: "summarized" }
  | { type: "summaryFailed" }
  | { type: "recover"; lastAudioAt: number; hasAudio: boolean }
  /** A launch found a delete still owed, or files a meeting whose audio is gone should not have. */
  | { type: "audioFound" };

export type MeetingEffect =
  | { type: "startCapture"; leg: number }
  | { type: "stopCapture" }
  | { type: "drain" }
  | { type: "finalize" }
  | { type: "applyFinalPass"; segments: readonly FinalSegment[] }
  /** Removes every audio file. Only a meeting whose audio is `deleting` asks for it. */
  | { type: "deleteAudio" }
  | { type: "watch"; watch: Watch }
  | { type: "schedule"; leg: number; timer: Timer; inMs: number }
  | { type: "mark"; marker: MarkerKind }
  | { type: "summarize" }
  | { type: "cancelSummary" }
  | { type: "generateTitle" }
  | { type: "delete" }
  | { type: "notify"; notice: MeetingNotice };

export type Step = { meeting: Meeting | null; effects: MeetingEffect[] };

export const maxLengthWarningMs = (maxLength: MaxLength) => (maxLength === "30m" ? 2 : 5) * 60_000;
export const SILENCE_PROMPT_MS = 10 * 60_000;
export const SILENCE_STOP_MS = 30_000;
const SHORT_RECORDING_WORDS = 10;
const HELPER_EXIT_LIMIT = 2;

const notify = (notice: MeetingNotice): MeetingEffect => ({ type: "notify", notice });
const mark = (marker: MarkerKind): MeetingEffect => ({ type: "mark", marker });
const watch = (what: Watch): MeetingEffect => ({ type: "watch", watch: what });

const gone = (effects: MeetingEffect[]): Step => ({
  meeting: null,
  effects: [...effects, { type: "delete" }],
});

const withStatus = (meeting: Meeting, status: MeetingStatus): Meeting => ({ ...meeting, status });

function closeLeg(meeting: Meeting, since: number, end: number, status: MeetingStatus): Meeting {
  const span = { startedAt: since, endedAt: Math.max(since, end) };
  return { ...meeting, spans: [...meeting.spans, span], status };
}

const finishing = (meeting: Meeting, effects: MeetingEffect[]): Step => ({
  meeting: withStatus(meeting, { kind: "finishing" }),
  effects: [...effects, watch("drain")],
});

const draining = (meeting: Meeting): Step => ({
  meeting: withStatus(meeting, { kind: "transcribing", step: "draining" }),
  effects: [{ type: "drain" }, watch("drain")],
});

const finalizing = (meeting: Meeting): Step => ({
  meeting: withStatus(meeting, { kind: "transcribing", step: "finalizing" }),
  effects: [{ type: "finalize" }, watch("finalPass")],
});

function helperExited(
  meeting: Meeting,
  status: Extract<MeetingStatus, { kind: "finishing" | "transcribing" }>,
  lost: Step,
): Step {
  const helperExits = (status.helperExits ?? 0) + 1;
  if (helperExits >= HELPER_EXIT_LIMIT) return lost;
  return { meeting: withStatus(meeting, { ...status, helperExits }), effects: [] };
}

const summarizing = (meeting: Meeting): Step => ({
  meeting: withStatus(meeting, { kind: "summarizing", progress: null }),
  effects: [{ type: "summarize" }],
});

function afterTranscript(meeting: Meeting, effects: MeetingEffect[]): Step {
  if (meeting.summary.kind === "none" && summarizesOnStop(meeting)) {
    const next = summarizing(meeting);
    return { ...next, effects: [...effects, ...next.effects] };
  }
  const title: MeetingEffect[] = meeting.title === null ? [{ type: "generateTitle" }] : [];
  return { meeting: withStatus(meeting, { kind: "ready" }), effects: [...effects, ...title] };
}

const finalPassFailed = (meeting: Meeting, reason: FinalPassFailure): Step =>
  afterTranscript({ ...meeting, finalPassFailed: reason }, [
    notify({ kind: "finalPassFailed", reason }),
  ]);

/**
 * A resume of a finished meeting whose audio is gone starts new files. One whose delete is still
 * owed waits for it, because the new leg would add to what is left of the old audio.
 */
function resume(meeting: Meeting, from: "paused" | "ready", config: LifecycleConfig): Step {
  if (meeting.audio === "deleting") return { meeting, effects: [] };
  if (recordedMs(meeting, 0) >= maxLengthMs[config.maxLength]) {
    return { meeting, effects: [notify({ kind: "atMaxLength" })] };
  }
  return {
    meeting: { ...withStatus(meeting, { kind: "starting", from }), audio: "present" },
    effects: [watch("start"), { type: "startCapture", leg: meeting.spans.length }],
  };
}

/**
 * A resume that ends before it records puts the meeting back where the resume began. A finished
 * meeting has audio only while a failed final pass keeps it, so the files this start made are
 * deleted. The helper can still be opening the devices and make its files after that delete, so
 * the audio stays `deleting` until the helper answers the start, and the answer deletes again.
 */
function resumeEnded(meeting: Meeting, from: "paused" | "ready", then: MeetingEffect[]): Step {
  const back = withStatus(meeting, { kind: from });
  const ended = from === "ready" ? dropAudio(back) : { meeting: back, effects: [] };
  return { meeting: ended.meeting, effects: [{ type: "stopCapture" }, ...ended.effects, ...then] };
}

const lossMessage = ({ source, reason }: AudioLoss) => {
  if (reason === "permission") {
    return `Voice is not allowed to record ${source === "mic" ? "the microphone" : "system audio"}.`;
  }
  return source === "mic" ? "The microphone stopped." : "System audio stopped.";
};

function startFailure(event: MeetingEvent): string | null {
  switch (event.type) {
    case "captureFailed":
      return event.message;
    case "captureLost":
      return lossMessage(event.loss);
    case "stalled":
      return event.watch === "start" ? "Recording did not start. Try again." : null;
    case "helperExited":
      return "Voice's audio helper stopped. Try again.";
    default:
      return null;
  }
}

export function step(
  meeting: Meeting | null,
  event: MeetingEvent,
  now: number,
  config: LifecycleConfig,
): Step {
  const same: Step = { meeting, effects: [] };
  if (meeting === null) {
    if (event.type !== "start") return same;
    return {
      meeting: {
        id: event.id,
        title: null,
        createdAt: now,
        spans: [],
        status: { kind: "starting", from: "new" },
        folderIds: [],
        notes: "",
        summary: { kind: "none" },
        speakers: [],
        finalPassFailed: null,
        audio: "present",
        transcriptRevision: 0,
      },
      effects: [watch("start"), { type: "startCapture", leg: 0 }],
    };
  }

  const { status } = meeting;
  const leg = meeting.spans.length;
  if ("leg" in event && event.leg !== leg) return same;
  if (event.type === "delete") return gone([]);

  if (event.type === "recover") {
    switch (status.kind) {
      case "starting": {
        if (!event.hasAudio && status.from !== "paused") {
          return status.from === "new"
            ? gone([])
            : dropAudio(withStatus(meeting, { kind: "ready" }));
        }
        const end = Math.max(event.lastAudioAt, meeting.spans.at(-1)?.endedAt ?? meeting.createdAt);
        const since = status.from === "new" ? meeting.createdAt : end;
        return draining(closeLeg(meeting, since, end, status));
      }
      case "recording":
        return draining(closeLeg(meeting, status.since, event.lastAudioAt, status));
      case "paused":
      case "finishing":
      case "confirmingShort":
      case "transcribing":
        return draining(meeting);
      case "summarizing":
        return summarizing(meeting);
      case "ready":
        return same;
    }
  }

  switch (status.kind) {
    case "starting": {
      const failure = startFailure(event);
      if (failure !== null) {
        if (status.from === "new") return gone([notify({ kind: "startFailed", message: failure })]);
        return resumeEnded(meeting, status.from, [
          notify({ kind: "resumeFailed", message: failure }),
        ]);
      }
      switch (event.type) {
        case "captureStarted": {
          const left = maxLengthMs[config.maxLength] - recordedMs(meeting, now);
          return {
            meeting: withStatus(meeting, { kind: "recording", since: now }),
            effects: [
              ...(leg > 0 ? [mark("resumed")] : []),
              {
                type: "schedule",
                leg,
                timer: "maxLengthWarning",
                inMs: Math.max(0, left - maxLengthWarningMs(config.maxLength)),
              },
              { type: "schedule", leg, timer: "maxLength", inMs: left },
            ],
          };
        }
        case "pause":
          if (status.from === "new") return same;
          return resumeEnded(meeting, status.from, []);
        case "stop":
          if (status.from === "new") return gone([]);
          if (status.from === "ready") return resumeEnded(meeting, "ready", []);
          return finishing(meeting, [{ type: "stopCapture" }, { type: "drain" }]);
        case "discard":
          return gone([]);
        default:
          return same;
      }
    }
    case "recording": {
      const close = (next: MeetingStatus) => closeLeg(meeting, status.since, now, next);
      const stopped = (notice: MeetingNotice | null) =>
        finishing(close({ kind: "finishing" }), [
          { type: "stopCapture" },
          ...(notice ? [notify(notice)] : []),
        ]);
      switch (event.type) {
        case "pause":
          return {
            meeting: close({ kind: "paused" }),
            effects: [{ type: "stopCapture" }, mark("paused")],
          };
        case "stop":
          return stopped(null);
        case "captureFailed":
        case "captureLost":
        case "helperExited":
          return {
            meeting: close({ kind: "paused" }),
            effects: [
              mark("gap"),
              notify({
                kind: "captureLost",
                loss: event.type === "captureLost" ? event.loss : null,
              }),
            ],
          };
        case "timer":
          if (event.timer === "maxLength") return stopped({ kind: "maxLengthReached" });
          if (event.timer === "silenceStop") return stopped({ kind: "silenceStopped" });
          return {
            meeting,
            effects: [
              notify({
                kind: "maxLengthSoon",
                inMs: Math.max(0, maxLengthMs[config.maxLength] - recordedMs(meeting, now)),
              }),
            ],
          };
        case "silence":
          if (!config.silencePrompt) return same;
          return {
            meeting,
            effects: [
              notify({ kind: "silence" }),
              { type: "schedule", leg, timer: "silenceStop", inMs: SILENCE_STOP_MS },
            ],
          };
        case "systemAudioMissing":
          return {
            meeting,
            effects: [notify({ kind: "systemAudioMissing", reason: event.reason })],
          };
        case "discard":
          return gone([]);
        default:
          return same;
      }
    }
    case "paused":
      switch (event.type) {
        case "resume":
          return resume(meeting, "paused", config);
        case "stop":
          return finishing(meeting, [{ type: "drain" }]);
        case "discard":
          return gone([]);
        case "captureStarted":
          return { meeting, effects: [{ type: "stopCapture" }] };
        default:
          return same;
      }
    case "finishing":
      switch (event.type) {
        case "drained":
          return event.words < SHORT_RECORDING_WORDS
            ? { meeting: withStatus(meeting, { kind: "confirmingShort" }), effects: [] }
            : finalizing(meeting);
        case "stalled":
          return event.watch === "drain" ? finalizing(meeting) : same;
        case "helperExited":
          return helperExited(meeting, status, finalizing(meeting));
        case "helperReady":
          return { meeting, effects: [{ type: "drain" }, watch("drain")] };
        case "discard":
          return gone([]);
        default:
          return same;
      }
    case "confirmingShort":
      switch (event.type) {
        case "keep":
          return finalizing(meeting);
        case "discard":
          return gone([]);
        default:
          return same;
      }
    case "transcribing":
      if (status.step === "draining") {
        switch (event.type) {
          case "drained":
            return finalizing(meeting);
          case "stalled":
            return event.watch === "drain" ? finalizing(meeting) : same;
          case "helperExited":
            return helperExited(meeting, status, finalizing(meeting));
          case "helperReady":
            return { meeting, effects: [{ type: "drain" }, watch("drain")] };
          default:
            return same;
        }
      }
      switch (event.type) {
        case "finalPass":
          return { meeting, effects: [{ type: "applyFinalPass", segments: event.segments }] };
        case "finalized":
          return afterTranscript({ ...meeting, finalPassFailed: null, audio: "deleting" }, [
            { type: "deleteAudio" },
          ]);
        case "stalled":
          return event.watch === "finalPass" ? finalPassFailed(meeting, "other") : same;
        case "finalizeFailed":
          return finalPassFailed(meeting, event.reason);
        case "helperExited":
          return helperExited(meeting, status, finalPassFailed(meeting, "other"));
        case "helperReady":
          return { meeting, effects: [{ type: "finalize" }, watch("finalPass")] };
        default:
          return same;
      }
    case "summarizing":
      switch (event.type) {
        case "summaryProgress":
          return {
            meeting: withStatus(meeting, { kind: "summarizing", progress: event.progress }),
            effects: [],
          };
        case "summarized":
          return {
            meeting: withStatus(meeting, { kind: "ready" }),
            effects: [notify({ kind: "summaryReady", open: config.openSummaryWhenReady })],
          };
        case "summaryFailed": {
          const { summary } = meeting;
          const message = summary.kind === "failed" ? summary.message : null;
          return {
            meeting: withStatus(meeting, { kind: "ready" }),
            effects: [notify({ kind: "summaryFailed", message })],
          };
        }
        case "resume": {
          const next = resume(meeting, "ready", config);
          return next.meeting === meeting
            ? next
            : { ...next, effects: [{ type: "cancelSummary" }, ...next.effects] };
        }
        default:
          return finishedAudio(meeting, event) ?? same;
      }
    case "ready":
      switch (event.type) {
        case "resume":
          return resume(meeting, "ready", config);
        case "generateSummary":
          return summarizing(meeting);
        case "retryFinalPass":
          return meeting.finalPassFailed && meeting.audio === "present"
            ? finalizing(meeting)
            : same;
        default:
          return finishedAudio(meeting, event) ?? same;
      }
  }
}

/** A delete already owed keeps the same meeting, so a retry writes nothing before it removes. */
const deleting = (meeting: Meeting): Step => ({
  meeting:
    meeting.audio === "deleting" && meeting.finalPassFailed === null
      ? meeting
      : { ...meeting, finalPassFailed: null, audio: "deleting" },
  effects: [{ type: "deleteAudio" }],
});

/** A finished meeting keeps its audio only for Try again after a failed final pass. */
const dropAudio = (meeting: Meeting): Step =>
  meeting.finalPassFailed && meeting.audio === "present"
    ? { meeting, effects: [] }
    : deleting(meeting);

/**
 * Audio events of a finished meeting. Once deleting, the audio only goes: Delete audio and each
 * answer the helper gives to a start it may have opened files for delete again, and a failed
 * delete says so.
 */
function finishedAudio(meeting: Meeting, event: MeetingEvent): Step | null {
  const owed = meeting.audio === "deleting";
  switch (event.type) {
    case "deleteAudio":
      return owed || meeting.finalPassFailed ? deleting(meeting) : null;
    case "audioDeleteFailed":
      return owed ? { meeting, effects: [notify({ kind: "audioDeleteFailed" })] } : null;
    case "audioFound":
      return dropAudio(meeting);
    case "captureStarted": {
      const dropped = dropAudio(meeting);
      return { meeting: dropped.meeting, effects: [{ type: "stopCapture" }, ...dropped.effects] };
    }
    case "captureFailed":
    case "helperExited":
      return owed ? deleting(meeting) : null;
    default:
      return null;
  }
}

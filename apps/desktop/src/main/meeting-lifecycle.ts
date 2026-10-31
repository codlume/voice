import {
  maxLengthMs,
  recordedMs,
  summarizesOnStop,
  type AudioLoss,
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

/** What a watchdog guards: a capture start, the live transcript catching up, the final pass. */
export type Watch = "start" | "drain" | "finalPass";

/**
 * `leg` is the index of the recording leg an event is about, which is the meeting's span count
 * while that leg is open, so an event from an earlier leg changes nothing. A watchdog names what
 * it guarded, so one that fires after its phase ended changes nothing either.
 */
export type MeetingEvent =
  | { type: "start"; id: MeetingId }
  | { type: "resume" }
  | { type: "captureStarted"; leg: number }
  | { type: "captureFailed"; leg: number; message: string }
  | { type: "captureLost"; leg: number; loss: AudioLoss }
  | { type: "pause" }
  | { type: "stop" }
  | { type: "timer"; leg: number; timer: Timer }
  /** Ten minutes without a transcript segment from either source. */
  | { type: "silence"; leg: number }
  /** The live transcript caught up with the audio; `words` is the meeting's word count. */
  | { type: "drained"; words: number }
  | { type: "finalPass"; segments: readonly FinalSegment[] }
  /** The final pass replaced the live transcript. */
  | { type: "finalized" }
  | { type: "finalizeFailed" }
  | { type: "stalled"; watch: Watch }
  /** The helper (re)started: it knows nothing of the work it was doing. */
  | { type: "helperReady" }
  | { type: "helperExited" }
  | { type: "keep" }
  | { type: "discard" }
  | { type: "delete" }
  | { type: "retryFinalPass" }
  | { type: "deleteAudio" }
  | { type: "generateSummary" }
  | { type: "summaryProgress"; progress: SummaryProgress }
  /** `meeting-summary.ts` has written the summary, or the failure with the previous one, to the meeting. */
  | { type: "summarized" }
  | { type: "summaryFailed" }
  /** A launch found the meeting unfinished. `lastAudioAt` closes a leg the crash left open. */
  | { type: "recover"; lastAudioAt: number };

/**
 * The driver only executes these. It writes `meeting.json` whenever the step returns a different
 * meeting object, and ties its timers to statuses: a watchdog ends when the status it was armed
 * in does, leg timers when the recording does. A mark is placed at the end of the recorded audio,
 * which only the driver can read: segments are in audio time, so markers must be too.
 */
export type MeetingEffect =
  | { type: "startCapture"; leg: number }
  /** Ends the leg; the helper keeps transcribing what was recorded and reports `drained`. */
  | { type: "stopCapture" }
  /** Transcribes what the transcript does not reach yet, without recording. */
  | { type: "drain" }
  | { type: "finalize" }
  /** Writes the final pass in place of the live transcript, then reports `finalized`. */
  | { type: "applyFinalPass"; segments: readonly FinalSegment[] }
  | { type: "deleteAudio" }
  | { type: "watch"; watch: Watch }
  | { type: "schedule"; leg: number; timer: Timer; inMs: number }
  | { type: "mark"; marker: MarkerKind }
  | { type: "summarize" }
  | { type: "cancelSummary" }
  /** A meeting left without a summary still gets a title when its title is blank. */
  | { type: "generateTitle" }
  /** Cancels whatever the helper does for the meeting, stops its work, and removes its folder. */
  | { type: "delete" }
  | { type: "notify"; notice: MeetingNotice };

export type Step = { meeting: Meeting | null; effects: MeetingEffect[] };

/** Wispr's lead: 2 minutes before a 30-minute limit, 5 before longer ones. */
export const maxLengthWarningMs = (maxLength: MaxLength) => (maxLength === "30m" ? 2 : 5) * 60_000;
export const SILENCE_PROMPT_MS = 10 * 60_000;
/** An unanswered "Still in a meeting?" stops the recording after this long, as Wispr does. */
export const SILENCE_STOP_MS = 30_000;
/** Below this the user is asked "Started by mistake?" before anything else runs. */
export const SHORT_RECORDING_WORDS = 10;

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

const summarizing = (meeting: Meeting): Step => ({
  meeting: withStatus(meeting, { kind: "summarizing", progress: null }),
  effects: [{ type: "summarize" }],
});

// A resumed meeting keeps its summary, which is now stale and offers "Update summary". The
// summary writes a blank title; without one, the title is written on its own.
function afterTranscript(meeting: Meeting, effects: MeetingEffect[]): Step {
  if (meeting.summary.kind === "none" && summarizesOnStop(meeting)) {
    const next = summarizing(meeting);
    return { ...next, effects: [...effects, ...next.effects] };
  }
  const title: MeetingEffect[] = meeting.title === null ? [{ type: "generateTitle" }] : [];
  return { meeting: withStatus(meeting, { kind: "ready" }), effects: [...effects, ...title] };
}

function resume(meeting: Meeting, from: "paused" | "ready", config: LifecycleConfig): Step {
  if (recordedMs(meeting, 0) >= maxLengthMs[config.maxLength]) {
    return { meeting, effects: [notify({ kind: "atMaxLength" })] };
  }
  return {
    meeting: withStatus(meeting, { kind: "starting", from }),
    effects: [watch("start"), { type: "startCapture", leg: meeting.spans.length }],
  };
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

/**
 * One meeting's lifecycle: starting, recording and paused, then finishing, an optional
 * "Started by mistake?" check, the final transcription pass, the summary, and ready. A null
 * meeting is one that does not exist: before a start, after a failed start, after a discard or
 * a delete. Only an explicit start or resume asks for capture; recovery only ever finalizes.
 * Every status has a way out, and a delete ends any of them.
 */
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
        finalPassFailed: false,
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
      case "starting":
        if (status.from === "new") return gone([]);
        return status.from === "ready"
          ? { meeting: withStatus(meeting, { kind: "ready" }), effects: [] }
          : draining(meeting);
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
        return {
          meeting: withStatus(meeting, { kind: status.from }),
          effects: [{ type: "stopCapture" }, notify({ kind: "resumeFailed", message: failure })],
        };
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
          return {
            meeting: withStatus(meeting, { kind: status.from }),
            effects: [{ type: "stopCapture" }],
          };
        case "stop":
          if (status.from === "new") return gone([]);
          if (status.from === "ready") {
            return {
              meeting: withStatus(meeting, { kind: "ready" }),
              effects: [{ type: "stopCapture" }],
            };
          }
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
        // A start that came back after it timed out: the meeting stays paused.
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
        // Without a word count the meeting is kept rather than asked about.
        case "stalled":
          return event.watch === "drain" ? finalizing(meeting) : same;
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
          return afterTranscript({ ...meeting, finalPassFailed: false }, [{ type: "deleteAudio" }]);
        case "stalled":
          if (event.watch !== "finalPass") return same;
          return afterTranscript({ ...meeting, finalPassFailed: true }, [
            notify({ kind: "finalPassFailed" }),
          ]);
        case "finalizeFailed":
          return afterTranscript({ ...meeting, finalPassFailed: true }, [
            notify({ kind: "finalPassFailed" }),
          ]);
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
        // The summary in progress gives way; the one before it, if any, is then stale.
        case "resume": {
          const next = resume(meeting, "ready", config);
          return next.meeting === meeting
            ? next
            : { ...next, effects: [{ type: "cancelSummary" }, ...next.effects] };
        }
        case "deleteAudio":
          return audioDeleted(meeting);
        default:
          return same;
      }
    case "ready":
      switch (event.type) {
        case "resume":
          return resume(meeting, "ready", config);
        case "generateSummary":
          return summarizing(meeting);
        case "retryFinalPass":
          return meeting.finalPassFailed ? finalizing(meeting) : same;
        case "deleteAudio":
          return audioDeleted(meeting);
        case "captureStarted":
          return { meeting, effects: [{ type: "stopCapture" }] };
        default:
          return same;
      }
  }
}

// The live transcript becomes the meeting's transcript for good.
const audioDeleted = (meeting: Meeting): Step =>
  meeting.finalPassFailed
    ? { meeting: { ...meeting, finalPassFailed: false }, effects: [{ type: "deleteAudio" }] }
    : { meeting, effects: [] };

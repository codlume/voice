import {
  maxLengthMs,
  recordedMs,
  summarizesOnStop,
  type AudioLoss,
  type MarkerKind,
  type Meeting,
  type MeetingId,
  type MeetingNotice,
  type MeetingStatus,
  type MeetingsSettings,
} from "../shared/meetings.ts";

export type LifecycleConfig = Pick<
  MeetingsSettings,
  "maxLength" | "silencePrompt" | "openSummaryWhenReady"
>;

export type Timer = "maxLengthWarning" | "maxLength";

/**
 * `leg` is the index of the recording leg an event is about, which is the meeting's span count
 * while that leg is open, so an event from an earlier leg changes nothing. The driver arms the
 * watchdogs: a drain, final pass or summary that hangs comes back as its failure event.
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
  | { type: "silence"; leg: number }
  /** The live transcript is flushed after the last leg; `words` is the meeting's word count. */
  | { type: "drained"; words: number }
  | { type: "keep" }
  | { type: "discard" }
  | { type: "transcribed" }
  | { type: "transcribeFailed" }
  | { type: "generateSummary" }
  /** `meeting-summary.ts` has written the summary, or the failure with the previous one, to the meeting. */
  | { type: "summarized" }
  | { type: "summaryFailed" }
  /** A launch found the meeting unfinished. `lastAudioAt` closes a leg the crash left open. */
  | { type: "recover"; lastAudioAt: number };

/**
 * The driver writes `meeting.json` whenever the step returns a different meeting object. A mark
 * is placed at the end of the recorded audio, which only the driver can read: segments are in
 * audio time, so markers must be too, and wall-clock time drifts from it.
 */
export type MeetingEffect =
  | { type: "startCapture"; leg: number }
  | { type: "stopCapture"; leg: number }
  | { type: "schedule"; leg: number; timer: Timer; inMs: number }
  | { type: "mark"; marker: MarkerKind }
  | { type: "transcribeFinal" }
  | { type: "summarize" }
  /** A meeting left without a summary still gets a title when its title is blank. */
  | { type: "generateTitle" }
  | { type: "delete" }
  | { type: "notify"; notice: MeetingNotice };

export type Step = { meeting: Meeting | null; effects: MeetingEffect[] };

export const MAX_LENGTH_WARNING_MS = 5 * 60_000;
export const SILENCE_PROMPT_MS = 10 * 60_000;
/** Below this the user is asked "Started by mistake?" before anything else runs. */
export const SHORT_RECORDING_WORDS = 10;

const notify = (notice: MeetingNotice): MeetingEffect => ({ type: "notify", notice });
const mark = (marker: MarkerKind): MeetingEffect => ({ type: "mark", marker });

const gone = (effects: MeetingEffect[]): Step => ({
  meeting: null,
  effects: [...effects, { type: "delete" }],
});

const withStatus = (meeting: Meeting, status: MeetingStatus): Meeting => ({ ...meeting, status });

function closeLeg(meeting: Meeting, since: number, end: number, status: MeetingStatus): Meeting {
  const span = { startedAt: since, endedAt: Math.max(since, end) };
  return { ...meeting, spans: [...meeting.spans, span], status };
}

const transcribing = (meeting: Meeting): Step => ({
  meeting: withStatus(meeting, { kind: "transcribing" }),
  effects: [{ type: "transcribeFinal" }],
});

const summarizing = (meeting: Meeting): Step => ({
  meeting: withStatus(meeting, { kind: "summarizing" }),
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
    effects: [{ type: "startCapture", leg: meeting.spans.length }],
  };
}

const lossMessage = ({ source, reason }: AudioLoss) => {
  if (reason === "permission") {
    return `Voice is not allowed to record ${source === "mic" ? "the microphone" : "system audio"}.`;
  }
  return source === "mic" ? "The microphone stopped." : "System audio stopped.";
};

/**
 * One meeting's lifecycle: starting, recording and paused, then finishing, an optional
 * "Started by mistake?" check, the final transcription pass, the summary, and ready. A null
 * meeting is one that does not exist: before a start, after a failed start, after a discard.
 * Only an explicit start or resume asks for capture; recovery only ever finalizes.
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
      },
      effects: [{ type: "startCapture", leg: 0 }],
    };
  }

  const { status } = meeting;
  const leg = meeting.spans.length;
  if ("leg" in event && event.leg !== leg) return same;

  if (event.type === "recover") {
    switch (status.kind) {
      case "starting":
        if (status.from === "new") return gone([]);
        return status.from === "ready"
          ? { meeting: withStatus(meeting, { kind: "ready" }), effects: [] }
          : transcribing(meeting);
      case "recording":
        return transcribing(
          closeLeg(meeting, status.since, event.lastAudioAt, { kind: "transcribing" }),
        );
      case "paused":
      case "finishing":
      case "confirmingShort":
      case "transcribing":
        return transcribing(meeting);
      case "summarizing":
        return summarizing(meeting);
      case "ready":
        return same;
    }
  }

  switch (status.kind) {
    case "starting": {
      const stopCapture: MeetingEffect = { type: "stopCapture", leg };
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
                inMs: Math.max(0, left - MAX_LENGTH_WARNING_MS),
              },
              { type: "schedule", leg, timer: "maxLength", inMs: left },
            ],
          };
        }
        case "captureFailed":
        case "captureLost": {
          const message = event.type === "captureFailed" ? event.message : lossMessage(event.loss);
          if (status.from === "new") return gone([notify({ kind: "startFailed", message })]);
          return {
            meeting: withStatus(meeting, { kind: status.from }),
            effects: [notify({ kind: "resumeFailed", message })],
          };
        }
        case "pause":
          if (status.from === "new") return same;
          return { meeting: withStatus(meeting, { kind: status.from }), effects: [stopCapture] };
        case "stop":
          if (status.from === "new") return gone([stopCapture]);
          if (status.from === "ready") {
            return { meeting: withStatus(meeting, { kind: "ready" }), effects: [stopCapture] };
          }
          return { meeting: withStatus(meeting, { kind: "finishing" }), effects: [stopCapture] };
        case "discard":
          return gone([stopCapture]);
        default:
          return same;
      }
    }
    case "recording": {
      const stopCapture: MeetingEffect = { type: "stopCapture", leg };
      const close = (next: MeetingStatus) => closeLeg(meeting, status.since, now, next);
      switch (event.type) {
        case "pause":
          return { meeting: close({ kind: "paused" }), effects: [stopCapture, mark("paused")] };
        case "stop":
          return { meeting: close({ kind: "finishing" }), effects: [stopCapture] };
        case "captureFailed":
        case "captureLost":
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
          if (event.timer === "maxLengthWarning") {
            const inMs = Math.max(0, maxLengthMs[config.maxLength] - recordedMs(meeting, now));
            return { meeting, effects: [notify({ kind: "maxLengthSoon", inMs })] };
          }
          return {
            meeting: close({ kind: "finishing" }),
            effects: [stopCapture, notify({ kind: "maxLengthReached" })],
          };
        case "silence":
          return config.silencePrompt ? { meeting, effects: [notify({ kind: "silence" })] } : same;
        case "discard":
          return gone([stopCapture]);
        default:
          return same;
      }
    }
    case "paused":
      switch (event.type) {
        case "resume":
          return resume(meeting, "paused", config);
        case "stop":
          return { meeting: withStatus(meeting, { kind: "finishing" }), effects: [] };
        case "discard":
          return gone([]);
        default:
          return same;
      }
    case "finishing":
      switch (event.type) {
        case "drained":
          return event.words < SHORT_RECORDING_WORDS
            ? { meeting: withStatus(meeting, { kind: "confirmingShort" }), effects: [] }
            : transcribing(meeting);
        case "discard":
          return gone([]);
        default:
          return same;
      }
    case "confirmingShort":
      switch (event.type) {
        case "keep":
          return transcribing(meeting);
        case "discard":
          return gone([]);
        default:
          return same;
      }
    case "transcribing":
      switch (event.type) {
        case "transcribed":
          return afterTranscript(meeting, []);
        case "transcribeFailed":
          return afterTranscript(meeting, [notify({ kind: "finalPassFailed" })]);
        default:
          return same;
      }
    case "summarizing":
      switch (event.type) {
        case "summarized":
          return {
            meeting: withStatus(meeting, { kind: "ready" }),
            effects: [notify({ kind: "summaryReady", open: config.openSummaryWhenReady })],
          };
        case "summaryFailed":
          return {
            meeting: withStatus(meeting, { kind: "ready" }),
            effects: [notify({ kind: "summaryFailed" })],
          };
        default:
          return same;
      }
    case "ready":
      switch (event.type) {
        case "resume":
          return resume(meeting, "ready", config);
        case "generateSummary":
          return summarizing(meeting);
        default:
          return same;
      }
  }
}

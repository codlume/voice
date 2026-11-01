import { randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import * as NodePath from "node:path";

import type { Microphone } from "../shared/api.ts";
import type { DictationLanguage } from "../shared/dictation-language.ts";
import {
  isLive,
  meetingToggle,
  recordedMs,
  type Marker,
  type MarkerKind,
  type Meeting,
  type MeetingCommandResult,
  type MeetingId,
  type MeetingNotice,
  type MeetingPartial,
  type MeetingSource,
  type MeetingTranscriptChange,
  type Segment,
  type TranscriptEntry,
} from "../shared/meetings.ts";
import { writeFileAtomic } from "./atomic-file.ts";
import type { Log } from "./diagnostics-scrub.ts";
import { applyFinalPass } from "./meeting-final-pass.ts";
import {
  SILENCE_PROMPT_MS,
  step,
  type MeetingEffect,
  type MeetingEvent,
  type Step,
  type Timer,
  type Watch,
} from "./meeting-lifecycle.ts";
import type { MeetingSummarizer } from "./meeting-summary.ts";
import type { MeetingsStore } from "./meetings-store.ts";
import type { HelperCommand, HelperEvent, MeetingCursor } from "./protocol.ts";

export type MeetingRecorder = {
  start(): Promise<MeetingCommandResult>;
  /** Stops the live meeting, or starts one; a meeting still starting is left to start. */
  toggle(): Promise<MeetingCommandResult>;
  pause(id: MeetingId): Promise<MeetingCommandResult>;
  resume(id: MeetingId): Promise<MeetingCommandResult>;
  stop(id: MeetingId): Promise<MeetingCommandResult>;
  /** Answers "Started by mistake?". */
  keep(id: MeetingId): Promise<MeetingCommandResult>;
  discard(id: MeetingId): Promise<MeetingCommandResult>;
  generateSummary(id: MeetingId): Promise<MeetingCommandResult>;
  /** Runs a failed final pass again over the audio it kept. */
  retryFinalPass(id: MeetingId): Promise<MeetingCommandResult>;
  /** Deletes the audio a failed final pass kept; the live transcript stays. */
  deleteAudio(id: MeetingId): Promise<MeetingCommandResult>;
  /** Answers "Still in a meeting?" with yes, so the recording does not stop. */
  keepRecording(id: MeetingId): void;
  /** Deletes a meeting in any status, stopping its capture and its work first. */
  remove(id: MeetingId): Promise<void>;
  onHelperEvent(event: HelperEvent): void;
  helperExited(): void;
  /** Finishes every meeting a crash or quit left unfinished, from its audio files. Never records. */
  recover(): Promise<void>;
  settled(): Promise<void>;
  /** Stops summaries without writing anything, so a quit leaves them for the next launch. */
  dispose(): void;
};

export type MeetingRecorderDeps = {
  store: MeetingsStore;
  /** The store's directory; each meeting's audio lives in its folder. */
  dir: string;
  send: (command: HelperCommand) => boolean;
  capture: () => { language: DictationLanguage; microphone: Microphone | null };
  onTranscript: (change: MeetingTranscriptChange) => void;
  /** Unconfirmed live text, passed straight on and never saved. */
  onPartial?: (partial: MeetingPartial) => void;
  onNotice: (id: MeetingId, notice: MeetingNotice) => void;
  /** Writes summaries and titles to the meeting; its work is aborted when the meeting is deleted. */
  summarizer: Pick<MeetingSummarizer, "summarizeMeeting" | "generateTitle">;
  log: Log;
  now?: () => number;
};

/**
 * Without a word from the helper for this long, a start, drain or final pass counts as stalled.
 * Only the start counts from the command; the others count while speech recognition can run,
 * so a model still loading after a launch is not taken for a stall.
 */
export const START_TIMEOUT_MS = 10_000;
export const TRANSCRIBE_IDLE_MS = 60_000;
/** The final pass reports only when done, for up to three hours of audio. */
export const FINAL_PASS_TIMEOUT_MS = 20 * 60_000;
const WATCH_MS: Record<Watch, number> = {
  start: START_TIMEOUT_MS,
  drain: TRANSCRIBE_IDLE_MS,
  finalPass: FINAL_PASS_TIMEOUT_MS,
};

const PCM_FILES = ["mic.pcm", "system.pcm"] as const;
/** Deleted with the audio; `audio.json` goes separately, last. */
const AUDIO_FILES = [...PCM_FILES, "output.ndjson"] as const;
/** 16 kHz mono Int16. */
const PCM_BYTES_PER_MS = 32;

const REFUSALS: Partial<Record<MeetingEvent["type"], string>> = {
  pause: "The meeting is not recording.",
  resume: "This meeting cannot be resumed now.",
  stop: "The meeting is not recording.",
  keep: "This meeting no longer asks to be kept.",
  discard: "This meeting can no longer be discarded.",
  generateSummary: "A summary cannot be written now.",
  retryFinalPass: "There is no kept audio to transcribe again.",
  deleteAudio: "There is no kept audio to delete.",
};

const FAILED_START = "Recording could not start. Check your microphone, then try again.";

/** After these the final pass, or the live transcript in its place, is the transcript. */
const takesLiveLines = (meeting: Meeting) =>
  meeting.status.kind !== "summarizing" && meeting.status.kind !== "ready";

type Watchdog = { watch: Watch; timer: NodeJS.Timeout | null };

/**
 * Executes `meeting-lifecycle.ts` against the helper: each event is stepped one at a time, the
 * meeting written, then its effects run. An effect that throws comes back as its failure event.
 * Audio is written by the helper into the meeting's folder; this module only names the folder,
 * tracks how far the transcript reaches, and deletes the audio once the transcript is final.
 */
export function createMeetingRecorder(deps: MeetingRecorderDeps): MeetingRecorder {
  const { store, log } = deps;
  const now = deps.now ?? Date.now;
  const summaries = new Map<MeetingId, AbortController>();
  const timers = new Map<MeetingId, Map<Timer, NodeJS.Timeout>>();
  const watchdogs = new Map<MeetingId, Watchdog>();
  const silence = new Map<MeetingId, NodeJS.Timeout>();
  // Where the open leg's audio starts, from the helper's `meeting.started`.
  const legStart = new Map<MeetingId, number>();
  // False while speech recognition loads, as after a launch, when it cannot report yet.
  let recognizing = false;
  let queue: Promise<unknown> = Promise.resolve();
  // Starts, resumes, toggles and the launch recovery run one at a time and each decides on the
  // state the one before left, so two quick presses never record two meetings and a press during
  // launch never stops a meeting recovery is about to finish.
  let decisions: Promise<unknown> = Promise.resolve();
  function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const decided = decisions.then(work);
    decisions = decided.catch(() => {});
    return decided;
  }
  // Helper events start work outside the queue; `settled` waits for it too.
  const inflight = new Set<Promise<unknown>>();

  function background(what: string, work: Promise<unknown>) {
    const tracked = work.catch((error) => log(`meetings: ${what} failed (${String(error)})`));
    inflight.add(tracked);
    void tracked.finally(() => inflight.delete(tracked));
  }

  /** Summary and title work, one per meeting; a delete aborts it, and an abort ends it quietly. */
  async function summaryWork(id: MeetingId, work: (signal: AbortSignal) => Promise<unknown>) {
    summaries.get(id)?.abort();
    const controller = new AbortController();
    summaries.set(id, controller);
    try {
      await work(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (summaries.get(id) === controller) summaries.delete(id);
    }
  }

  const folder = (id: MeetingId) => NodePath.join(deps.dir, id);
  const config = () => store.state().settings;

  /** Resolves with whether the event changed anything. */
  function dispatch(id: MeetingId, event: MeetingEvent): Promise<boolean> {
    const next = queue.then(() => apply(id, event));
    queue = next.catch((error) => log(`meetings: ${event.type} failed (${String(error)})`));
    return next;
  }

  async function apply(id: MeetingId, event: MeetingEvent): Promise<boolean> {
    // Stepped inside the store's write, so a notes or folder edit queued meanwhile is not lost.
    let before = null as Meeting | null;
    let stepped: Step = { meeting: null, effects: [] };
    await store.upsert(id, (latest) => {
      before = latest;
      stepped = step(latest, event, now(), config());
      return stepped.meeting;
    });
    const { meeting, effects } = stepped;
    if (meeting?.status !== before?.status) statusChanged(id, before, meeting);
    for (const effect of effects) await runOrFail(id, meeting ?? before, effect);
    return meeting !== before || effects.length > 0;
  }

  // A watchdog guards one status; leg timers and the silence prompt guard one recording.
  function statusChanged(id: MeetingId, before: Meeting | null, after: Meeting | null) {
    unwatch(id);
    const recording = after?.status.kind === "recording";
    if (before?.status.kind === "recording" && !recording) {
      clearTimers(id);
      clearSilence(id);
    }
    if (recording && before?.status.kind !== "recording") armSilence(id);
  }

  async function runOrFail(id: MeetingId, meeting: Meeting | null, effect: MeetingEffect) {
    try {
      await run(id, meeting, effect);
    } catch (error) {
      log(`meetings: ${effect.type} failed (${String(error)})`);
      const failed = failureOf(effect);
      if (failed) background(effect.type, dispatch(id, failed));
    }
  }

  function failureOf(effect: MeetingEffect): MeetingEvent | null {
    switch (effect.type) {
      case "startCapture":
        return { type: "captureFailed", leg: effect.leg, message: FAILED_START };
      case "drain":
        return { type: "stalled", watch: "drain" };
      case "finalize":
      case "applyFinalPass":
        return { type: "finalizeFailed", reason: "other" };
      default:
        return null;
    }
  }

  async function run(id: MeetingId, meeting: Meeting | null, effect: MeetingEffect) {
    switch (effect.type) {
      case "startCapture": {
        if (meeting === null) return;
        const { language, microphone } = deps.capture();
        const length = await audioLength(id);
        const baseMs = await audioBase(meeting);
        if (length === null) {
          await writeFileAtomic(
            NodePath.join(folder(id), "audio.json"),
            JSON.stringify({ baseMs }),
            { mode: 0o600 },
          );
        }
        const sent = deps.send({
          type: "meeting.start",
          id,
          dir: folder(id),
          baseMs,
          fromMs: await cursor(id),
          language,
          microphone,
        });
        if (!sent) {
          const message = "Voice is reconnecting. Try again.";
          background("start", dispatch(id, { type: "captureFailed", leg: effect.leg, message }));
        }
        return;
      }
      case "stopCapture":
        deps.send({ type: "meeting.stop", id });
        return;
      // A helper that is not running gets these again once it is ready.
      case "drain":
        if (meeting === null) return;
        deps.send({
          type: "meeting.transcribe",
          id,
          dir: folder(id),
          baseMs: await audioBase(meeting),
          fromMs: await cursor(id),
          language: deps.capture().language,
        });
        return;
      case "finalize":
        if (meeting === null) return;
        deps.send({
          type: "meeting.finalize",
          id,
          dir: folder(id),
          baseMs: await audioBase(meeting),
          language: deps.capture().language,
        });
        return;
      case "applyFinalPass": {
        if (meeting === null) return;
        const fromMs = await audioBase(meeting);
        const live = await store.transcript(id);
        // An empty pass over audio the live transcript found words in failed, whatever it says.
        if (
          effect.segments.length === 0 &&
          live.some((entry) => entry.kind === "segment" && entry.startMs >= fromMs)
        ) {
          log(`meetings: ${id} final pass found no words the live transcript heard`);
          background("final pass", dispatch(id, { type: "finalizeFailed", reason: "other" }));
          return;
        }
        await store.replaceTranscript(id, (current, transcript) =>
          applyFinalPass(current, transcript, effect.segments, fromMs),
        );
        background("final pass", dispatch(id, { type: "finalized" }));
        return;
      }
      case "deleteAudio":
        await deleteAudio(id);
        return;
      case "watch":
        arm(id, effect.watch);
        return;
      case "schedule": {
        const legTimers = timers.get(id) ?? new Map<Timer, NodeJS.Timeout>();
        clearTimeout(legTimers.get(effect.timer));
        const fire = () =>
          background(
            "timer",
            dispatch(id, { type: "timer", leg: effect.leg, timer: effect.timer }),
          );
        legTimers.set(effect.timer, setTimeout(fire, effect.inMs));
        timers.set(id, legTimers);
        return;
      }
      case "mark":
        if (meeting === null) return;
        await mark(meeting, effect.marker);
        return;
      case "summarize":
        background("summary", summarize(id));
        return;
      case "cancelSummary":
        summaries.get(id)?.abort(new Error("Meeting resumed"));
        return;
      case "generateTitle":
        background(
          "title",
          summaryWork(id, (signal) => deps.summarizer.generateTitle(id, { signal })),
        );
        return;
      case "delete":
        summaries.get(id)?.abort(new Error("Meeting deleted"));
        clearTimers(id);
        clearSilence(id);
        unwatch(id);
        legStart.delete(id);
        deps.send({ type: "meeting.cancel", id });
        await store.remove(id);
        return;
      case "notify":
        deps.onNotice(id, effect.notice);
        return;
    }
  }

  function summarize(id: MeetingId) {
    return summaryWork(id, async (signal) => {
      let ok = false;
      try {
        ({ ok } = await deps.summarizer.summarizeMeeting(id, {
          signal,
          onProgress: (reached) => {
            if (signal.aborted) return;
            const event = { type: "summaryProgress", progress: reached } as const;
            background("summary progress", dispatch(id, event));
          },
        }));
      } finally {
        if (!signal.aborted) await dispatch(id, { type: ok ? "summarized" : "summaryFailed" });
      }
    });
  }

  async function segment(event: Extract<HelperEvent, { type: "meeting.segment" }>) {
    const id = event.id as MeetingId;
    const meeting = store.get(id);
    if (!meeting || !takesLiveLines(meeting)) return;
    const base = {
      kind: "segment",
      id: randomUUID(),
      startMs: event.startMs,
      endMs: event.endMs,
      text: event.text,
    } as const;
    // System audio is "Others" until the final pass tells its speakers apart.
    const entry: Segment =
      event.source === "mic"
        ? { ...base, source: "mic" }
        : { ...base, source: "system", speakerId: null };
    await save(id, [entry]);
    if (watchdogs.get(id)?.watch === "drain") progress(id);
    if (silence.has(id)) heard(id);
  }

  async function mark(meeting: Meeting, kind: MarkerKind) {
    const resumedAt = kind === "resumed" ? legStart.get(meeting.id) : undefined;
    const atMs = resumedAt ?? (await audioNow(meeting));
    const marker: Marker = { kind: "marker", marker: kind, atMs };
    await save(meeting.id, [marker]);
  }

  async function save(id: MeetingId, entries: readonly TranscriptEntry[]) {
    const revision = await store.append(id, entries);
    if (revision !== null) deps.onTranscript({ id, entries, revision });
  }

  // A dictation mid-meeting: the helper records silence for it, and the transcript says why.
  async function dictated() {
    const meeting = store.state().meetings.find(({ status }) => status.kind === "recording");
    if (meeting) await mark(meeting, "dictated");
  }

  /** The longer audio file's length in ms, or null while neither exists. */
  async function audioLength(id: MeetingId): Promise<number | null> {
    const sizes = await Promise.all(
      PCM_FILES.map((name) =>
        stat(NodePath.join(folder(id), name)).then(
          ({ size }) => size,
          () => null,
        ),
      ),
    );
    const found = sizes.filter((size) => size !== null);
    return found.length === 0 ? null : Math.max(...found) / PCM_BYTES_PER_MS;
  }

  /**
   * Meeting time at the audio files' first byte. It is 0 until the audio is deleted after a final
   * transcript; a resume after that starts new files after everything already transcribed, and
   * `audio.json` remembers where.
   */
  async function audioBase(meeting: Meeting): Promise<number> {
    if ((await audioLength(meeting.id)) === null) {
      return Math.max(recordedMs(meeting, now()), reach(await store.transcript(meeting.id)));
    }
    const saved = await readFile(NodePath.join(folder(meeting.id), "audio.json"), "utf8").then(
      (text) => (JSON.parse(text) as { baseMs?: unknown }).baseMs,
      () => 0,
    );
    return typeof saved === "number" && Number.isFinite(saved) && saved >= 0 ? saved : 0;
  }

  /** Meeting time at the end of the recorded audio, the time base segments use. */
  async function audioNow(meeting: Meeting): Promise<number> {
    const length = await audioLength(meeting.id);
    return (await audioBase(meeting)) + (length ?? 0);
  }

  async function cursor(id: MeetingId): Promise<MeetingCursor> {
    const reach: MeetingCursor = { mic: 0, system: 0 };
    for (const entry of await store.transcript(id)) {
      if (entry.kind !== "segment") continue;
      const source: MeetingSource = entry.source;
      reach[source] = Math.max(reach[source], entry.endMs);
    }
    return reach;
  }

  // `audio.json` goes last: without it, audio files left on disk would read as starting at 0.
  async function deleteAudio(id: MeetingId) {
    await Promise.all(
      AUDIO_FILES.map((name) => rm(NodePath.join(folder(id), name), { force: true })),
    );
    await rm(NodePath.join(folder(id), "audio.json"), { force: true });
  }

  function arm(id: MeetingId, watch: Watch) {
    unwatch(id);
    const watchdog: Watchdog = { watch, timer: null };
    watchdogs.set(id, watchdog);
    if (watch === "start" || recognizing) count(id, watchdog);
  }

  function count(id: MeetingId, watchdog: Watchdog) {
    clearTimeout(watchdog.timer ?? undefined);
    watchdog.timer = setTimeout(() => {
      watchdogs.delete(id);
      background("watchdog", dispatch(id, { type: "stalled", watch: watchdog.watch }));
    }, WATCH_MS[watchdog.watch]);
  }

  /** Word from the helper about what a watchdog guards starts its count again. */
  function progress(id: MeetingId) {
    const watchdog = watchdogs.get(id);
    if (watchdog?.timer) count(id, watchdog);
  }

  function setRecognizing(next: boolean) {
    recognizing = next;
    for (const [id, watchdog] of watchdogs) {
      if (watchdog.watch === "start") continue;
      if (next && watchdog.timer === null) count(id, watchdog);
      if (!next && watchdog.timer) {
        clearTimeout(watchdog.timer);
        watchdog.timer = null;
      }
    }
  }

  function unwatch(id: MeetingId) {
    clearTimeout(watchdogs.get(id)?.timer ?? undefined);
    watchdogs.delete(id);
  }

  function clearTimers(id: MeetingId) {
    for (const timer of timers.get(id)?.values() ?? []) clearTimeout(timer);
    timers.delete(id);
  }

  // Ten minutes without a transcript segment from either source asks whether the meeting ended.
  function armSilence(id: MeetingId) {
    clearTimeout(silence.get(id));
    silence.set(
      id,
      setTimeout(() => {
        const meeting = store.get(id);
        if (meeting?.status.kind !== "recording") return;
        armSilence(id);
        background("silence", dispatch(id, { type: "silence", leg: meeting.spans.length }));
      }, SILENCE_PROMPT_MS),
    );
  }

  // Speech, or a yes to "Still in a meeting?", means the meeting goes on.
  function heard(id: MeetingId) {
    const legTimers = timers.get(id);
    clearTimeout(legTimers?.get("silenceStop"));
    legTimers?.delete("silenceStop");
    armSilence(id);
  }

  function clearSilence(id: MeetingId) {
    clearTimeout(silence.get(id));
    silence.delete(id);
  }

  async function command(id: MeetingId, event: MeetingEvent): Promise<MeetingCommandResult> {
    if (!store.get(id))
      return { kind: "refused", message: "This meeting is no longer on this Mac." };
    if (event.type === "resume") {
      const other = store.state().meetings.find((meeting) => meeting.id !== id && isLive(meeting));
      if (other) return { kind: "refused", message: "Stop the other meeting first." };
    }
    if (await dispatch(id, event)) return { kind: "ok", id };
    return { kind: "refused", message: REFUSALS[event.type] ?? "This cannot be done now." };
  }

  async function start(): Promise<MeetingCommandResult> {
    await store.loaded();
    const { meetings } = store.state();
    if (meetings.some(isLive)) {
      return { kind: "refused", message: "A meeting is already recording or paused." };
    }
    // An unanswered "Started by mistake?" keeps its meeting rather than lose it.
    for (const meeting of meetings) {
      if (meeting.status.kind === "confirmingShort") await dispatch(meeting.id, { type: "keep" });
    }
    const id = randomUUID() as MeetingId;
    await dispatch(id, { type: "start", id });
    // A start that failed before reaching the helper queued its failure behind the start.
    await queue;
    return store.get(id)
      ? { kind: "ok", id }
      : { kind: "refused", message: "Recording did not start." };
  }

  return {
    start: () => oneAtATime(start),
    toggle: () =>
      oneAtATime(async () => {
        await store.loaded();
        const next = meetingToggle(store.state().meetings);
        switch (next.kind) {
          case "start":
            return start();
          case "stop":
            return command(next.id, { type: "stop" });
          case "wait":
            return { kind: "refused", message: "The meeting is still starting." };
        }
      }),
    pause: (id) => command(id, { type: "pause" }),
    resume: (id) => oneAtATime(() => command(id, { type: "resume" })),
    stop: (id) => command(id, { type: "stop" }),
    keep: (id) => command(id, { type: "keep" }),
    discard: (id) => command(id, { type: "discard" }),
    generateSummary: (id) => command(id, { type: "generateSummary" }),
    retryFinalPass: (id) => command(id, { type: "retryFinalPass" }),
    deleteAudio: (id) => command(id, { type: "deleteAudio" }),
    keepRecording(id) {
      if (silence.has(id)) heard(id);
    },
    async remove(id) {
      await dispatch(id, { type: "delete" });
    },
    onHelperEvent(event) {
      switch (event.type) {
        case "ready":
          for (const meeting of store.state().meetings) {
            const { kind } = meeting.status;
            if (kind === "finishing" || kind === "transcribing")
              background("helper ready", dispatch(meeting.id, { type: "helperReady" }));
          }
          return;
        case "asr.status":
          setRecognizing(event.state !== "loading" && event.state !== "downloading");
          return;
        case "capture.started":
          background("dictated marker", dictated());
          return;
        case "meeting.lost": {
          const id = event.id as MeetingId;
          const meeting = store.get(id);
          if (!meeting) return;
          const loss = { source: event.source, reason: event.reason };
          log(`meetings: ${id} lost ${loss.source} audio (${loss.reason})`);
          background(
            event.type,
            dispatch(id, { type: "captureLost", leg: meeting.spans.length, loss }),
          );
          return;
        }
        case "meeting.started": {
          const id = event.id as MeetingId;
          const meeting = store.get(id);
          // A start that came back after its meeting was given up on records for nothing.
          if (!meeting) {
            deps.send({ type: "meeting.cancel", id });
            return;
          }
          legStart.set(id, event.atMs);
          background(
            event.type,
            dispatch(id, { type: "captureStarted", leg: meeting.spans.length }),
          );
          return;
        }
        case "meeting.failed": {
          const id = event.id as MeetingId;
          const meeting = store.get(id);
          if (!meeting) return;
          // The helper's error names devices and error codes, which help a log, not the user.
          log(`meetings: ${id} capture failed (${event.message})`);
          const failed = { type: "captureFailed", leg: meeting.spans.length } as const;
          background(event.type, dispatch(id, { ...failed, message: FAILED_START }));
          return;
        }
        case "meeting.segment":
          background("saving a segment", segment(event));
          return;
        case "meeting.drained": {
          const id = event.id as MeetingId;
          if (!store.get(id)) return;
          if (event.failure !== null)
            log(`meetings: ${id} live transcript stalled (${event.failure})`);
          const drained = async () =>
            dispatch(id, { type: "drained", words: words(await store.transcript(id)) });
          background("drain", drained());
          return;
        }
        case "meeting.partial": {
          const id = event.id as MeetingId;
          const meeting = store.get(id);
          if (meeting && takesLiveLines(meeting))
            deps.onPartial?.({ id, source: event.source, text: event.text });
          return;
        }
        case "meeting.finalized":
        case "meeting.finalizeFailed": {
          // The helper runs final passes one after another: one ending means the queue moved.
          for (const [id, watchdog] of watchdogs) if (watchdog.watch === "finalPass") progress(id);
          const id = event.id as MeetingId;
          if (event.type === "meeting.finalizeFailed") {
            log(`meetings: ${id} final pass failed: ${event.reason} (${event.message})`);
            const reason = event.reason === "speakerModels" ? "speakerModels" : "other";
            background("final pass", dispatch(id, { type: "finalizeFailed", reason }));
          } else {
            const arrived = { type: "finalPass", segments: event.segments } as const;
            background("final pass", dispatch(id, arrived));
          }
          return;
        }
        default:
          return;
      }
    },
    helperExited() {
      // A new helper knows nothing of the old one's work; `ready` sends it again.
      setRecognizing(false);
      for (const id of watchdogs.keys()) unwatch(id);
      for (const meeting of store.state().meetings) {
        background("helper exit", dispatch(meeting.id, { type: "helperExited" }));
      }
    },
    recover: () =>
      oneAtATime(async () => {
        await store.loaded();
        for (const { meeting, lastWriteAt } of await store.unfinished()) {
          await dispatch(meeting.id, { type: "recover", lastAudioAt: lastWriteAt });
        }
      }),
    async settled() {
      while (true) {
        const current = queue;
        const pending = [...inflight];
        await Promise.all([current, ...pending]);
        if (current === queue && inflight.size === 0) return;
      }
    },
    dispose() {
      for (const controller of summaries.values()) controller.abort(new Error("Voice is closing"));
    },
  };
}

/** The latest meeting time the transcript holds anything at. */
const reach = (transcript: readonly TranscriptEntry[]) =>
  Math.max(0, ...transcript.map((entry) => (entry.kind === "segment" ? entry.endMs : entry.atMs)));

const words = (transcript: readonly TranscriptEntry[]) =>
  transcript.reduce(
    (count, entry) =>
      entry.kind === "segment" ? count + entry.text.split(/\s+/).filter(Boolean).length : count,
    0,
  );

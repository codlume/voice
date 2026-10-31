import { randomUUID } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import type { Microphone } from "../shared/api.ts";
import type { DictationLanguage } from "../shared/dictation-language.ts";
import {
  recordedMs,
  type Meeting,
  type MeetingCommandResult,
  type MeetingId,
  type MeetingNotice,
  type MeetingSource,
  type Segment,
  type TranscriptEntry,
} from "../shared/meetings.ts";
import type { Log } from "./diagnostics-scrub.ts";
import {
  SILENCE_PROMPT_MS,
  step,
  type MeetingEffect,
  type MeetingEvent,
} from "./meeting-lifecycle.ts";
import type { MeetingsStore } from "./meetings-store.ts";
import type { HelperCommand, HelperEvent, MeetingCursor } from "./protocol.ts";

export type MeetingRecorder = {
  start(): Promise<MeetingCommandResult>;
  pause(id: MeetingId): Promise<MeetingCommandResult>;
  resume(id: MeetingId): Promise<MeetingCommandResult>;
  stop(id: MeetingId): Promise<MeetingCommandResult>;
  /** Answers "Started by mistake?". */
  keep(id: MeetingId): Promise<MeetingCommandResult>;
  discard(id: MeetingId): Promise<MeetingCommandResult>;
  generateSummary(id: MeetingId): Promise<MeetingCommandResult>;
  onHelperEvent(event: HelperEvent): void;
  helperExited(): void;
  /** Finishes every meeting a crash or quit left unfinished, from its audio files. Never records. */
  recover(): Promise<void>;
  settled(): Promise<void>;
};

export type MeetingRecorderDeps = {
  store: MeetingsStore;
  /** The store's directory; each meeting's audio lives in its folder. */
  dir: string;
  send: (command: HelperCommand) => boolean;
  capture: () => { language: DictationLanguage; microphone: Microphone | null };
  onTranscript: (id: MeetingId, entries: readonly TranscriptEntry[]) => void;
  onNotice: (id: MeetingId, notice: MeetingNotice) => void;
  /**
   * Step 3's more accurate pass over the whole recording. It runs once the live transcript has
   * caught up and before the audio is deleted, so it may still read the files.
   */
  finalPass?: (id: MeetingId) => Promise<void>;
  /** Step 4's summary. Until it exists a summary request fails and the transcript is kept. */
  summarize?: (id: MeetingId) => Promise<string>;
  log: Log;
  now?: () => number;
};

/** Without a word from the helper for this long, a start, drain or final pass counts as failed. */
export const START_TIMEOUT_MS = 10_000;
export const TRANSCRIBE_IDLE_MS = 60_000;

const AUDIO_FILES = ["mic.pcm", "system.pcm", "audio.json"] as const;
const live = (meeting: Meeting) =>
  meeting.status.kind === "recording" || meeting.status.kind === "starting";
const noFinalPass = async () => {};
const noSummary = async (): Promise<string> => {
  throw new Error("Summaries are not available yet.");
};

/**
 * Drives `meeting-lifecycle.ts` against the helper: each event is stepped one at a time, the
 * meeting written, then its effects run. Audio is written by the helper into the meeting's
 * folder; this module only names the folder, tracks how far the transcript reaches, and deletes
 * the audio once the transcript is final.
 */
export function createMeetingRecorder(deps: MeetingRecorderDeps): MeetingRecorder {
  const { store, log } = deps;
  const now = deps.now ?? Date.now;
  const finalPass = deps.finalPass ?? noFinalPass;
  const summarize = deps.summarize ?? noSummary;
  const timers = new Map<MeetingId, NodeJS.Timeout[]>();
  const watchdogs = new Map<MeetingId, NodeJS.Timeout>();
  const silence = new Map<MeetingId, NodeJS.Timeout>();
  // Meetings whose final pass waits for `meeting.drained`; resent when the helper comes back.
  const finalPending = new Set<MeetingId>();
  let queue: Promise<unknown> = Promise.resolve();
  // Helper events start work outside the queue; `settled` waits for it too.
  const inflight = new Set<Promise<unknown>>();

  function background(what: string, work: Promise<unknown>) {
    const tracked = work.catch((error) => log(`meetings: ${what} failed (${String(error)})`));
    inflight.add(tracked);
    void tracked.finally(() => inflight.delete(tracked));
  }

  const folder = (id: MeetingId) => NodePath.join(deps.dir, id);
  const config = () => store.state().settings;

  function dispatch(id: MeetingId, event: MeetingEvent): Promise<Meeting | null> {
    const next = queue.then(() => apply(id, event));
    queue = next.catch((error) => log(`meetings: ${event.type} failed (${String(error)})`));
    return next;
  }

  async function apply(id: MeetingId, event: MeetingEvent): Promise<Meeting | null> {
    const before = store.get(id);
    if (before === null && event.type !== "start") return null;
    const { meeting, effects } = step(before, event, now(), config());
    if (meeting !== null && meeting !== before) await store.put(meeting);
    if (meeting?.status.kind !== "recording") clearSilence(id);
    if (meeting?.status.kind === "recording" && before?.status.kind !== "recording") armSilence(id);
    for (const effect of effects) await run(id, meeting ?? before, effect);
    return meeting;
  }

  async function run(id: MeetingId, meeting: Meeting | null, effect: MeetingEffect) {
    switch (effect.type) {
      case "startCapture": {
        if (meeting === null) return;
        const { language, microphone } = deps.capture();
        const baseMs = await audioBase(meeting);
        const fromMs = await cursor(id);
        const sent = deps.send({
          type: "meeting.start",
          id,
          dir: folder(id),
          baseMs,
          fromMs,
          language,
          microphone,
        });
        const failed = { type: "captureFailed", leg: effect.leg } as const;
        if (!sent) {
          background(
            "start",
            dispatch(id, { ...failed, message: "Voice is reconnecting. Try again." }),
          );
          return;
        }
        watch(id, START_TIMEOUT_MS, () =>
          dispatch(id, { ...failed, message: "Recording did not start." }),
        );
        return;
      }
      case "stopCapture":
        clearTimers(id);
        deps.send({ type: "meeting.stop", id });
        watch(id, TRANSCRIBE_IDLE_MS, () => drained(id, "transcription stalled"));
        return;
      case "schedule": {
        const timer = setTimeout(
          () =>
            background(
              "timer",
              dispatch(id, { type: "timer", leg: effect.leg, timer: effect.timer }),
            ),
          effect.inMs,
        );
        timers.set(id, [...(timers.get(id) ?? []), timer]);
        return;
      }
      case "mark":
        await store.append(id, [effect.marker]);
        deps.onTranscript(id, [effect.marker]);
        return;
      case "transcribeFinal":
        finalPending.add(id);
        await sendTranscribe(id);
        return;
      case "summarize":
        background(
          "summary",
          summarize(id).then(
            (markdown) => dispatch(id, { type: "summarized", markdown }),
            (error: unknown) =>
              dispatch(id, {
                type: "summaryFailed",
                message: error instanceof Error ? error.message : String(error),
              }),
          ),
        );
        return;
      case "delete":
        clearTimers(id);
        clearSilence(id);
        unwatch(id);
        finalPending.delete(id);
        deps.send({ type: "meeting.cancel", id });
        await store.remove(id);
        return;
      case "notify":
        deps.onNotice(id, effect.notice);
        return;
    }
  }

  async function sendTranscribe(id: MeetingId) {
    const meeting = store.get(id);
    if (!meeting) return;
    const sent = deps.send({
      type: "meeting.transcribe",
      id,
      dir: folder(id),
      baseMs: await audioBase(meeting),
      fromMs: await cursor(id),
      language: deps.capture().language,
    });
    // A helper that is not running gets the command again once it is ready.
    if (sent) watch(id, TRANSCRIBE_IDLE_MS, () => drained(id, "transcription stalled"));
  }

  // The live transcript has caught up with the audio, or gave up.
  async function drained(id: MeetingId, failure: string | null) {
    unwatch(id);
    const meeting = store.get(id);
    if (!meeting) return;
    if (meeting.status.kind === "finishing") {
      await dispatch(id, { type: "drained", words: words(await store.transcript(id)) });
      return;
    }
    if (meeting.status.kind !== "transcribing" || !finalPending.delete(id)) return;
    if (failure !== null) {
      log(`meetings: final transcription failed (${failure}); the audio is kept`);
      await dispatch(id, { type: "transcribeFailed" });
      return;
    }
    try {
      await finalPass(id);
      await deleteAudio(id);
    } catch (error) {
      log(`meetings: finishing the transcript failed (${String(error)})`);
      await dispatch(id, { type: "transcribeFailed" });
      return;
    }
    await dispatch(id, { type: "transcribed" });
  }

  async function segment(event: Extract<HelperEvent, { type: "meeting.segment" }>) {
    const id = event.id as MeetingId;
    if (!store.get(id)) return;
    const base = {
      kind: "segment",
      id: randomUUID(),
      startMs: event.startMs,
      endMs: event.endMs,
      text: event.text,
      final: true,
    } as const;
    // Speakers on system audio get names in step 3; until then they are "Others".
    const entry: Segment =
      event.source === "mic"
        ? { ...base, source: "mic" }
        : { ...base, source: "system", speaker: null };
    await store.append(id, [entry]);
    deps.onTranscript(id, [entry]);
    if (watchdogs.has(id))
      watch(id, TRANSCRIBE_IDLE_MS, () => drained(id, "transcription stalled"));
    if (silence.has(id)) armSilence(id);
  }

  // A dictation mid-meeting: the helper records silence for it, and the transcript says why.
  async function dictated() {
    const meeting = store.state().meetings.find(({ status }) => status.kind === "recording");
    if (!meeting) return;
    const marker = {
      kind: "marker",
      marker: "dictated",
      atMs: recordedMs(meeting, now()),
    } as const;
    await store.append(meeting.id, [marker]);
    deps.onTranscript(meeting.id, [marker]);
  }

  /**
   * Meeting time at the audio files' first byte. It is 0 until the audio is deleted after a final
   * transcript; a resume after that starts new files at the time recorded so far.
   */
  async function audioBase(meeting: Meeting): Promise<number> {
    const file = NodePath.join(folder(meeting.id), "audio.json");
    const hasAudio = await stat(NodePath.join(folder(meeting.id), "mic.pcm")).then(
      () => true,
      () => false,
    );
    if (hasAudio) {
      const saved = await readFile(file, "utf8").then(
        (text) => (JSON.parse(text) as { baseMs?: unknown }).baseMs,
        () => 0,
      );
      return typeof saved === "number" && Number.isFinite(saved) && saved >= 0 ? saved : 0;
    }
    const baseMs = recordedMs(meeting, now());
    if (live(meeting)) {
      await writeFile(file, JSON.stringify({ baseMs }), { mode: 0o600 });
    }
    return baseMs;
  }

  async function cursor(id: MeetingId): Promise<MeetingCursor> {
    const reach: MeetingCursor = { mic: 0, system: 0 };
    for (const entry of await store.transcript(id)) {
      if (entry.kind !== "segment" || !entry.final) continue;
      const source: MeetingSource = entry.source;
      reach[source] = Math.max(reach[source], entry.endMs);
    }
    return reach;
  }

  async function deleteAudio(id: MeetingId) {
    await Promise.all(
      AUDIO_FILES.map((name) => rm(NodePath.join(folder(id), name), { force: true })),
    );
  }

  function watch(id: MeetingId, ms: number, onTimeout: () => unknown) {
    unwatch(id);
    const timer = setTimeout(() => {
      watchdogs.delete(id);
      background("watchdog", Promise.resolve(onTimeout()));
    }, ms);
    watchdogs.set(id, timer);
  }

  function unwatch(id: MeetingId) {
    clearTimeout(watchdogs.get(id));
    watchdogs.delete(id);
  }

  function clearTimers(id: MeetingId) {
    for (const timer of timers.get(id) ?? []) clearTimeout(timer);
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

  function clearSilence(id: MeetingId) {
    clearTimeout(silence.get(id));
    silence.delete(id);
  }

  async function command(id: MeetingId, event: MeetingEvent): Promise<MeetingCommandResult> {
    if (!store.get(id))
      return { kind: "refused", message: "This meeting is no longer on this Mac." };
    if (event.type === "resume") {
      const other = store.state().meetings.find((meeting) => meeting.id !== id && live(meeting));
      if (other) return { kind: "refused", message: "Stop the meeting that is recording first." };
    }
    await dispatch(id, event);
    return { kind: "ok", id };
  }

  return {
    async start() {
      await store.loaded();
      if (store.state().meetings.some(live)) {
        return { kind: "refused", message: "A meeting is already recording." };
      }
      const id = randomUUID() as MeetingId;
      await dispatch(id, { type: "start", id });
      return store.get(id)
        ? { kind: "ok", id }
        : { kind: "refused", message: "Recording did not start." };
    },
    pause: (id) => command(id, { type: "pause" }),
    resume: (id) => command(id, { type: "resume" }),
    stop: (id) => command(id, { type: "stop" }),
    keep: (id) => command(id, { type: "keep" }),
    discard: (id) => command(id, { type: "discard" }),
    generateSummary: (id) => command(id, { type: "generateSummary" }),
    onHelperEvent(event) {
      switch (event.type) {
        case "ready":
          for (const id of finalPending) background("final pass", sendTranscribe(id));
          for (const meeting of store.state().meetings) {
            if (meeting.status.kind === "finishing")
              background("drain", sendTranscribe(meeting.id));
          }
          return;
        case "capture.started":
          background("dictated marker", dictated());
          return;
        case "meeting.started":
        case "meeting.failed": {
          const id = event.id as MeetingId;
          const meeting = store.get(id);
          if (!meeting) return;
          unwatch(id);
          const leg = meeting.spans.length;
          background(
            event.type,
            dispatch(
              id,
              event.type === "meeting.started"
                ? { type: "captureStarted", leg }
                : { type: "captureFailed", leg, message: event.message },
            ),
          );
          return;
        }
        case "meeting.segment":
          background("saving a segment", segment(event));
          return;
        case "meeting.drained":
          background("drain", drained(event.id as MeetingId, event.failure));
          return;
        default:
          return;
      }
    },
    helperExited() {
      for (const meeting of store.state().meetings) {
        if (!live(meeting)) continue;
        unwatch(meeting.id);
        background(
          "helper exit",
          dispatch(meeting.id, {
            type: "captureFailed",
            leg: meeting.spans.length,
            message: "Voice's audio helper stopped.",
          }),
        );
      }
    },
    async recover() {
      await store.loaded();
      for (const { meeting, lastWriteAt } of await store.unfinished()) {
        await dispatch(meeting.id, { type: "recover", lastAudioAt: lastWriteAt });
      }
    },
    async settled() {
      while (true) {
        const current = queue;
        const pending = [...inflight];
        await Promise.all([current, ...pending]);
        if (current === queue && inflight.size === 0) return;
      }
    },
  };
}

const words = (transcript: readonly TranscriptEntry[]) =>
  transcript.reduce(
    (count, entry) =>
      entry.kind === "segment" ? count + entry.text.split(/\s+/).filter(Boolean).length : count,
    0,
  );

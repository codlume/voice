import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import * as NodePath from "node:path";

import type { Microphone } from "../shared/api.ts";
import type { DictationLanguage } from "../shared/dictation-language.ts";
import {
  isCapturing,
  isLive,
  meetingToggle,
  recordedMs,
  type AudioLoss,
  type KeptAudio,
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
  toggle(): Promise<MeetingCommandResult>;
  pause(id: MeetingId): Promise<MeetingCommandResult>;
  resume(id: MeetingId): Promise<MeetingCommandResult>;
  stop(id: MeetingId): Promise<MeetingCommandResult>;
  keep(id: MeetingId): Promise<MeetingCommandResult>;
  discard(id: MeetingId): Promise<MeetingCommandResult>;
  generateSummary(id: MeetingId): Promise<MeetingCommandResult>;
  retryFinalPass(id: MeetingId): Promise<MeetingCommandResult>;
  deleteAudio(id: MeetingId): Promise<MeetingCommandResult>;
  keepRecording(id: MeetingId): void;
  remove(id: MeetingId): Promise<void>;
  onHelperEvent(event: HelperEvent): void;
  helperExited(): void;
  recover(): Promise<void>;
  settled(): Promise<void>;
  dispose(): void;
};

export type MeetingRecorderDeps = {
  store: MeetingsStore;
  dir: string;
  send: (command: HelperCommand) => boolean;
  capture: () => { language: DictationLanguage; microphone: Microphone | null };
  systemAudioSupported: () => boolean;
  onTranscript: (change: MeetingTranscriptChange) => void;
  onPartial?: (partial: MeetingPartial) => void;
  onNotice: (id: MeetingId, notice: MeetingNotice) => void;
  summarizer: Pick<MeetingSummarizer, "summarizeMeeting" | "generateTitle">;
  log: Log;
  now?: () => number;
};

export const START_TIMEOUT_MS = 10_000;
export const TRANSCRIBE_IDLE_MS = 60_000;
const FINAL_PASS_TIMEOUT_MS = 20 * 60_000;
const WATCH_MS: Record<Watch, number> = {
  start: START_TIMEOUT_MS,
  drain: TRANSCRIBE_IDLE_MS,
  finalPass: FINAL_PASS_TIMEOUT_MS,
};

const PCM_FILES = ["mic.pcm", "system.pcm"] as const;
const AUDIO_FILES = [...PCM_FILES, "output.ndjson"] as const;
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

/** What a command tells the user when one of its effects fails. Commands not listed report ok. */
const FAILURES: Partial<Record<MeetingEvent["type"], string>> = {
  deleteAudio: "The audio could not be deleted. Try again.",
};

/** Why a command refuses to work from a kept audio set that a failed Delete audio left part of. */
const INCOMPLETE = {
  retryFinalPass:
    "Part of this meeting's audio was already deleted, so it cannot be transcribed again. Delete audio to remove the rest.",
  resume:
    "Part of this meeting's audio was already deleted, so it cannot be resumed yet. Delete audio to remove the rest first.",
} as const;

const FAILED_START = "Recording could not start. Check your microphone, then try again.";

const takesLiveLines = (meeting: Meeting) =>
  meeting.status.kind !== "summarizing" && meeting.status.kind !== "ready";

type Watchdog = { watch: Watch; timer: NodeJS.Timeout | null };

type Applied = "unchanged" | "changed" | "failed";

export function createMeetingRecorder(deps: MeetingRecorderDeps): MeetingRecorder {
  const { store, log } = deps;
  const now = deps.now ?? Date.now;
  const summaries = new Map<MeetingId, AbortController>();
  const timers = new Map<MeetingId, Map<Timer, NodeJS.Timeout>>();
  const watchdogs = new Map<MeetingId, Watchdog>();
  const silence = new Map<MeetingId, NodeJS.Timeout>();
  const legStart = new Map<MeetingId, number>();
  const linesSaved = new Map<MeetingId, Promise<boolean>>();
  const heardWhole = new Set<MeetingId>();
  let recognizing = false;
  let queue: Promise<unknown> = Promise.resolve();
  let decisions: Promise<unknown> = Promise.resolve();
  function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const decided = decisions.then(work);
    decisions = decided.catch(() => {});
    return decided;
  }
  const inflight = new Set<Promise<unknown>>();

  function background(what: string, work: Promise<unknown>) {
    const tracked = work.catch((error) => log(`meetings: ${what} failed (${String(error)})`));
    inflight.add(tracked);
    void tracked.finally(() => inflight.delete(tracked));
  }

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

  function dispatch(id: MeetingId, event: MeetingEvent): Promise<Applied> {
    const next = queue.then(() => apply(id, event));
    queue = next.catch((error) => log(`meetings: ${event.type} failed (${String(error)})`));
    return next;
  }

  async function apply(id: MeetingId, event: MeetingEvent): Promise<Applied> {
    let before = null as Meeting | null;
    let stepped: Step = { meeting: null, effects: [] };
    await store.upsert(id, (latest) => {
      before = latest;
      stepped = step(latest, event, now(), config());
      // A resume that ends before it records deletes only what its start made. A relaunch reads
      // the saved `starting` without those files as the same `ready`, so that delete does not
      // wait for meeting.json. Waiting would leave the meeting stuck in `starting`.
      const endsResume = latest?.status.kind === "starting";
      const mustPersist = stepped.effects.some(
        ({ type }) => type === "startCapture" || (type === "deleteAudio" && !endsResume),
      );
      return { meeting: stepped.meeting, mustPersist };
    });
    const { meeting, effects } = stepped;
    if (meeting?.status !== before?.status) statusChanged(id, before, meeting);
    let applied: Applied = meeting !== before || effects.length > 0 ? "changed" : "unchanged";
    for (const effect of effects) {
      if (!(await runOrFail(id, meeting ?? before, effect))) applied = "failed";
    }
    return applied;
  }

  function statusChanged(id: MeetingId, before: Meeting | null, after: Meeting | null) {
    unwatch(id);
    const recording = after?.status.kind === "recording";
    if (before?.status.kind === "recording" && !recording) {
      clearTimers(id);
      clearSilence(id);
    }
    if (recording && before?.status.kind !== "recording") armSilence(id);
  }

  async function runOrFail(
    id: MeetingId,
    meeting: Meeting | null,
    effect: MeetingEffect,
  ): Promise<boolean> {
    try {
      await run(id, meeting, effect);
      return true;
    } catch (error) {
      log(`meetings: ${effect.type} failed (${String(error)})`);
      const failed = await failureOf(meeting, effect);
      if (failed) background(effect.type, dispatch(id, failed));
      return false;
    }
  }

  async function failureOf(
    meeting: Meeting | null,
    effect: MeetingEffect,
  ): Promise<MeetingEvent | null> {
    switch (effect.type) {
      case "startCapture":
        return { type: "captureFailed", leg: effect.leg, message: FAILED_START };
      case "drain":
        return { type: "stalled", watch: "drain" };
      case "finalize":
      case "applyFinalPass":
        return { type: "finalizeFailed", reason: "other" };
      case "deleteAudio": {
        if (!effect.keptFor || !meeting) return null;
        const audio = await keptAudio(meeting);
        return { type: "audioDeleteFailed", reason: effect.keptFor, audio };
      }
      default:
        return null;
    }
  }

  async function run(id: MeetingId, meeting: Meeting | null, effect: MeetingEffect) {
    switch (effect.type) {
      case "startCapture": {
        if (meeting === null) return;
        heardWhole.delete(id);
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
        if (
          effect.segments.length === 0 &&
          (!heardWhole.has(id) ||
            meeting.finalPassFailed !== null ||
            live.some((entry) => entry.kind === "segment" && entry.startMs >= fromMs))
        ) {
          log(`meetings: ${id} final pass found no words where the live transcript was not sure`);
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
        forgetLive(id);
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
        forgetLive(id);
        deps.send({ type: "meeting.cancel", id });
        await store.remove(id);
        return;
      case "notify":
        deps.onNotice(id, effect.notice);
        return;
    }
  }

  function forgetLive(id: MeetingId) {
    linesSaved.delete(id);
    heardWhole.delete(id);
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

  function systemAudioMissing(
    system: Extract<HelperEvent, { type: "meeting.started" }>["system"],
  ): AudioLoss["reason"] | null {
    if (system === "denied") return "permission";
    if (system === "unavailable" && deps.systemAudioSupported()) return "device";
    return null;
  }

  async function dictated() {
    const meeting = store.state().meetings.find(({ status }) => status.kind === "recording");
    if (meeting) await mark(meeting, "dictated");
  }

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
   * Whether the folder holds any of the meeting's audio files. An empty file counts, and so does
   * a lone `audio.json`, because a start that never recorded leaves both.
   */
  async function hasAudioFiles(id: MeetingId): Promise<boolean> {
    const names = new Set(await readdir(folder(id)).catch(() => []));
    return [...AUDIO_FILES, "audio.json"].some((name) => names.has(name));
  }

  /**
   * A Delete audio that fails part way can remove one source's audio and keep the other's. A final
   * pass over what is left would replace that source's live lines with nothing, so the kept audio
   * is partly deleted when a source has live lines since the audio began but no audio on disk.
   */
  async function keptAudio(meeting: Meeting): Promise<KeptAudio> {
    const missing = new Set<MeetingSource>();
    for (const name of PCM_FILES) {
      const size = await stat(NodePath.join(folder(meeting.id), name)).then(
        (file) => file.size,
        () => 0,
      );
      if (size === 0) missing.add(name === "mic.pcm" ? "mic" : "system");
    }
    if (missing.size === 0) return "whole";
    const fromMs = await audioBase(meeting);
    const lost = (await store.transcript(meeting.id)).some(
      (entry) => entry.kind === "segment" && entry.startMs >= fromMs && missing.has(entry.source),
    );
    return lost ? "partlyDeleted" : "whole";
  }

  async function audioIncomplete(id: MeetingId): Promise<boolean> {
    await queue;
    const meeting = store.get(id);
    return !!meeting?.finalPassFailed && (await keptAudio(meeting)) === "partlyDeleted";
  }

  /** A notice does not outlive the app, so each launch raises it again from what is on disk. */
  async function raiseFinalPassNotices(meetings: readonly Meeting[]) {
    for (const meeting of meetings) {
      const reason = meeting.finalPassFailed;
      if (!reason) continue;
      const audio = await keptAudio(meeting);
      deps.onNotice(meeting.id, { kind: "finalPassFailed", reason, audio });
    }
  }

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

  /** Every removal ends before a failure is reported, so what is on disk then is what was left. */
  async function deleteAudio(id: MeetingId) {
    const removals = await Promise.allSettled(
      AUDIO_FILES.map((name) => rm(NodePath.join(folder(id), name), { force: true })),
    );
    for (const removal of removals) if (removal.status === "rejected") throw removal.reason;
    await rm(NodePath.join(folder(id), "audio.json"), { force: true });
  }

  /**
   * A finished meeting keeps audio only after a failed final pass. Audio it still has otherwise is
   * left over from a failed delete or a quit, and a resume that adds to it would transcribe that
   * leg again, so the resume starts new files instead. The leftover must be gone before the resume
   * is saved, because a relaunch transcribes whatever audio a resuming meeting has.
   */
  async function clearLeftoverAudio(id: MeetingId): Promise<boolean> {
    await queue;
    const meeting = store.get(id);
    const kind = meeting?.status.kind;
    if ((kind !== "ready" && kind !== "summarizing") || meeting?.finalPassFailed !== null) {
      return true;
    }
    return deleteAudio(id).then(
      () => true,
      (error) => {
        log(`meetings: ${id} leftover audio could not be deleted (${String(error)})`);
        return false;
      },
    );
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
    if ((event.type === "retryFinalPass" || event.type === "resume") && (await audioIncomplete(id)))
      return { kind: "refused", message: INCOMPLETE[event.type] };
    if (event.type === "resume" && !(await clearLeftoverAudio(id))) {
      const message = "Voice could not clear this meeting's old audio. Try again.";
      return { kind: "refused", message };
    }
    const applied = await dispatch(id, event);
    const failure = applied === "failed" ? FAILURES[event.type] : undefined;
    if (failure) return { kind: "refused", message: failure };
    if (applied !== "unchanged") return { kind: "ok", id };
    return { kind: "refused", message: REFUSALS[event.type] ?? "This cannot be done now." };
  }

  async function start(): Promise<MeetingCommandResult> {
    await store.loaded();
    const { meetings } = store.state();
    if (meetings.some(isLive)) {
      return { kind: "refused", message: "A meeting is already recording or paused." };
    }
    for (const meeting of meetings) {
      if (meeting.status.kind === "confirmingShort") await dispatch(meeting.id, { type: "keep" });
    }
    const id = randomUUID() as MeetingId;
    await dispatch(id, { type: "start", id });
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
          if (!meeting) {
            deps.send({ type: "meeting.cancel", id });
            return;
          }
          legStart.set(id, event.atMs);
          heardWhole.delete(id);
          const leg = meeting.spans.length;
          background(event.type, dispatch(id, { type: "captureStarted", leg }));
          const reason = systemAudioMissing(event.system);
          if (reason !== null) {
            background(event.type, dispatch(id, { type: "systemAudioMissing", leg, reason }));
          }
          return;
        }
        case "meeting.failed": {
          const id = event.id as MeetingId;
          const meeting = store.get(id);
          if (!meeting) return;
          log(`meetings: ${id} capture failed (${event.message})`);
          const failed = { type: "captureFailed", leg: meeting.spans.length } as const;
          background(event.type, dispatch(id, { ...failed, message: FAILED_START }));
          return;
        }
        case "meeting.segment": {
          const id = event.id as MeetingId;
          const saved = segment(event);
          background("saving a segment", saved);
          const before = linesSaved.get(id) ?? true;
          linesSaved.set(
            id,
            saved.then(
              async () => await before,
              () => false,
            ),
          );
          return;
        }
        case "meeting.drained": {
          const id = event.id as MeetingId;
          if (!store.get(id)) return;
          const leg = legStart.get(id);
          const drained = async () => {
            const saved = await (linesSaved.get(id) ?? true);
            if (event.failure === null && saved) {
              const meeting = store.get(id);
              if (meeting && !isCapturing(meeting) && legStart.get(id) === leg) heardWhole.add(id);
              return dispatch(id, { type: "drained", words: words(await store.transcript(id)) });
            }
            heardWhole.delete(id);
            const why = event.failure ?? "lines were not saved";
            log(`meetings: ${id} live transcript stalled (${why})`);
            return dispatch(id, { type: "stalled", watch: "drain" });
          };
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
      setRecognizing(false);
      for (const id of watchdogs.keys()) unwatch(id);
      for (const meeting of store.state().meetings) {
        background("helper exit", dispatch(meeting.id, { type: "helperExited" }));
      }
    },
    recover: () =>
      oneAtATime(async () => {
        await store.loaded();
        background("final pass notices", raiseFinalPassNotices(store.state().meetings));
        for (const { meeting, lastWriteAt } of await store.unfinished()) {
          const hasAudio = ((await audioLength(meeting.id)) ?? 0) > 0;
          await dispatch(meeting.id, { type: "recover", lastAudioAt: lastWriteAt, hasAudio });
        }
        const { meetings } = store.state();
        const found = await Promise.all(meetings.map(({ id }) => hasAudioFiles(id)));
        const withAudio = meetings.filter((_, index) => found[index]);
        for (const { id } of withAudio) await dispatch(id, { type: "audioFound" });
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

const reach = (transcript: readonly TranscriptEntry[]) =>
  Math.max(0, ...transcript.map((entry) => (entry.kind === "segment" ? entry.endMs : entry.atMs)));

const words = (transcript: readonly TranscriptEntry[]) =>
  transcript.reduce(
    (count, entry) =>
      entry.kind === "segment" ? count + entry.text.split(/\s+/).filter(Boolean).length : count,
    0,
  );

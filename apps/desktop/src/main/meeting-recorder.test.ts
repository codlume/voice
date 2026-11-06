import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type {
  Meeting,
  MeetingId,
  MeetingNotice,
  SpeakerId,
  TranscriptEntry,
} from "../shared/meetings.ts";
import { maxLengthWarningMs, SILENCE_PROMPT_MS, SILENCE_STOP_MS } from "./meeting-lifecycle.ts";
import type { FinalSegment } from "./meeting-final-pass.ts";
import {
  createMeetingRecorder,
  START_TIMEOUT_MS,
  TRANSCRIBE_IDLE_MS,
  type MeetingRecorderDeps,
} from "./meeting-recorder.ts";
import { createMeetingsStore } from "./meetings-store.ts";
import type { HelperCommand, HelperEvent } from "./protocol.ts";

const START = Date.UTC(2026, 9, 31, 9, 0);
const TEN_WORDS = "we agreed to ship the beta on friday after review";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(NodePath.join(tmpdir(), "voice-recorder-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

async function readOnly(folder: string, work: () => Promise<void>) {
  await chmod(folder, 0o500);
  try {
    await work();
  } finally {
    await chmod(folder, 0o700);
  }
}

async function meetingWritesFail(folder: string, work: () => Promise<void>) {
  const temp = NodePath.join(folder, `meeting.json.${process.pid}.tmp`);
  await mkdir(temp);
  try {
    await work();
  } finally {
    await rmdir(temp);
  }
}

function harness(overrides: Partial<MeetingRecorderDeps> = {}) {
  let clock = START;
  const store = createMeetingsStore({ dir, log: () => {}, onChange: () => {}, now: () => clock });
  const sent: HelperCommand[] = [];
  const pushed: TranscriptEntry[] = [];
  const noticed: MeetingNotice[] = [];
  const notices: MeetingNotice["kind"][] = [];
  const logs: string[] = [];
  let helperRunning = true;
  const recorder = createMeetingRecorder({
    store,
    dir,
    send: (command) => {
      if (!helperRunning) return false;
      sent.push(command);
      return true;
    },
    capture: () => ({ language: "en", microphone: null }),
    systemAudioSupported: () => true,
    onTranscript: ({ entries }) => pushed.push(...entries),
    onNotice: (_id, notice) => {
      noticed.push(notice);
      notices.push(notice.kind);
    },
    summarizer: {
      summarizeMeeting: async () => ({ ok: true }),
      generateTitle: async () => ({ ok: true, title: null }),
    },
    log: (line) => logs.push(line),
    now: () => clock,
    ...overrides,
  });
  const h = {
    store,
    recorder,
    sent,
    pushed,
    noticed,
    notices,
    logs,
    advance(ms: number) {
      clock += ms;
    },
    setHelperRunning(running: boolean) {
      helperRunning = running;
    },
    emit(event: HelperEvent) {
      recorder.onHelperEvent(event);
    },
    async settle() {
      for (let round = 0; round < 5; round += 1) {
        await recorder.settled();
        await store.settled();
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    sentTypes: () => sent.map(({ type }) => type),
    folder: (id: MeetingId) => NodePath.join(dir, id),
    async onDisk(id: MeetingId): Promise<Meeting> {
      const text = await readFile(NodePath.join(dir, id, "meeting.json"), "utf8");
      return (JSON.parse(text) as { meeting: Meeting }).meeting;
    },
    /** Grows both audio files to `ms` of 16 kHz mono Int16, as the helper writes them. */
    async audio(id: MeetingId, ms = 100) {
      await writeFile(NodePath.join(dir, id, "mic.pcm"), Buffer.alloc(ms * 32));
      await writeFile(NodePath.join(dir, id, "system.pcm"), Buffer.alloc(ms * 32));
    },
    async start() {
      const result = await recorder.start();
      if (result.kind !== "ok") throw new Error(`start refused: ${JSON.stringify(result)}`);
      h.emit({ type: "meeting.started", id: result.id, atMs: 0, mic: "active", system: "active" });
      await h.settle();
      await h.audio(result.id);
      return result.id;
    },
    async segment(id: MeetingId, source: "mic" | "system", startMs: number, text: string) {
      h.emit({ type: "meeting.segment", id, source, startMs, endMs: startMs + 2000, text });
      await h.settle();
    },
    async drained(id: MeetingId, failure: string | null = null) {
      h.emit({ type: "meeting.drained", id, failure });
      await h.settle();
    },
    /** The helper's final pass; by default it hears what the live transcript did. */
    async finalized(id: MeetingId, segments?: readonly FinalSegment[]) {
      const live = (await store.transcript(id)).flatMap((entry) =>
        entry.kind === "segment" ? [{ ...entry, speaker: null }] : [],
      );
      h.emit({ type: "meeting.finalized", id, segments: segments ?? live });
      await h.settle();
    },
    /** After Stop: the live tail, then the final pass. */
    async finish(id: MeetingId) {
      await h.drained(id);
      await h.finalized(id);
    },
  };
  return h;
}

describe("meeting recorder", () => {
  test("start records into the meeting's folder and live segments land in its transcript", async () => {
    const h = harness();
    const id = await h.start();
    expect(h.sent[0]).toEqual({
      type: "meeting.start",
      id,
      dir: h.folder(id),
      baseMs: 0,
      fromMs: { mic: 0, system: 0 },
      language: "en",
      microphone: null,
    });
    expect(h.store.get(id)?.status).toEqual({ kind: "recording", since: START });

    await h.segment(id, "mic", 0, "Hello everyone");
    await h.segment(id, "system", 2500, "Hi there");
    const transcript = await h.store.transcript(id);
    expect(transcript).toMatchObject([
      { kind: "segment", source: "mic", startMs: 0, text: "Hello everyone" },
      { kind: "segment", source: "system", speakerId: null, startMs: 2500, text: "Hi there" },
    ]);
    expect(h.pushed).toEqual(transcript);
  });

  test("a second start while one records or is paused is refused and records nothing", async () => {
    const h = harness();
    const id = await h.start();
    const refused = { kind: "refused", message: "A meeting is already recording or paused." };
    expect(await h.recorder.start()).toEqual(refused);
    await h.recorder.pause(id);
    await h.settle();
    expect(await h.recorder.start()).toEqual(refused);
    expect(h.sentTypes()).toEqual(["meeting.start", "meeting.stop"]);
    expect(h.store.state().meetings).toHaveLength(1);
  });

  test("a start the helper refuses leaves no meeting behind", async () => {
    const h = harness();
    const result = await h.recorder.start();
    if (result.kind !== "ok") throw new Error("start refused");
    h.emit({ type: "meeting.failed", id: result.id, message: "Allow microphone access" });
    await h.settle();
    expect(h.store.get(result.id)).toBeNull();
    expect(existsSync(h.folder(result.id))).toBe(false);
    expect(h.notices).toEqual(["startFailed"]);
  });

  test("pause stops the leg and resume appends to the same files from where the transcript ends", async () => {
    const h = harness();
    const id = await h.start();
    await h.segment(id, "mic", 1000, "First part");
    h.advance(60_000);
    await h.audio(id, 60_000);
    await h.recorder.pause(id);
    await h.settle();
    expect(h.sentTypes()).toEqual(["meeting.start", "meeting.stop"]);
    expect(h.store.get(id)?.status.kind).toBe("paused");

    h.advance(5 * 60_000);
    await h.recorder.resume(id);
    await h.settle();
    expect(h.sent.at(-1)).toMatchObject({
      type: "meeting.start",
      baseMs: 0,
      fromMs: { mic: 3000, system: 0 },
    });
    h.emit({ type: "meeting.started", id, atMs: 60_000, mic: "active", system: "unavailable" });
    await h.settle();
    expect(h.store.get(id)?.status.kind).toBe("recording");
    const markers = (await h.store.transcript(id)).filter((entry) => entry.kind === "marker");
    expect(markers).toEqual([
      { kind: "marker", marker: "paused", atMs: 60_000 },
      { kind: "marker", marker: "resumed", atMs: 60_000 },
    ]);
  });

  test("edits that land while the recorder steps a meeting are kept", async () => {
    const h = harness();
    const id = await h.start();
    const folder = await h.store.createFolder({ name: "Work", kind: "manual" });

    const filed = h.store.setInFolder(id, folder.id, true);
    const noted = h.store.update(id, (meeting) => ({ ...meeting, notes: "ship it" }));
    const paused = h.recorder.pause(id);
    await Promise.all([filed, noted, paused]);
    await h.settle();

    const saved = createMeetingsStore({ dir, log: () => {}, onChange: () => {} });
    await saved.loaded();
    for (const meeting of [h.store.get(id), saved.get(id)]) {
      expect(meeting).toMatchObject({
        status: { kind: "paused" },
        folderIds: [folder.id],
        notes: "ship it",
      });
    }
  });

  test("stop transcribes the tail, asks for the final pass while the audio exists, then deletes the audio", async () => {
    const h = harness();
    const id = await h.start();
    await h.segment(id, "mic", 0, TEN_WORDS);
    h.advance(120_000);
    await h.recorder.stop(id);
    await h.settle();
    expect(h.store.get(id)?.status.kind).toBe("finishing");

    await h.drained(id);
    expect(h.store.get(id)?.status).toEqual({ kind: "transcribing", step: "finalizing" });
    expect(h.sent.at(-1)).toEqual({
      type: "meeting.finalize",
      id,
      dir: h.folder(id),
      baseMs: 0,
      language: "en",
    });
    expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(true);
    expect(h.store.get(id)?.status.kind).toBe("transcribing");

    await h.finalized(id, [
      { source: "mic", startMs: 0, endMs: 1800, text: "We agreed to ship the beta", speaker: null },
      { source: "system", startMs: 2000, endMs: 3000, text: "On Friday", speaker: 0 },
      { source: "system", startMs: 3200, endMs: 4000, text: "After review", speaker: 1 },
    ]);
    for (const name of ["mic.pcm", "system.pcm", "audio.json"]) {
      expect(existsSync(NodePath.join(h.folder(id), name)), name).toBe(false);
    }
    expect(h.store.get(id)?.status.kind).toBe("ready");
    expect(h.store.get(id)?.speakers).toEqual([
      { id: "s1", label: "Speaker 1", name: null },
      { id: "s2", label: "Speaker 2", name: null },
    ]);
    expect(await h.store.transcript(id)).toMatchObject([
      { source: "mic", text: "We agreed to ship the beta" },
      { source: "system", speakerId: "s1", text: "On Friday" },
      { source: "system", speakerId: "s2", text: "After review" },
    ]);
  });

  test("a final pass the helper fails, or that finds nothing the live one heard, keeps the live transcript and the audio", async () => {
    for (const fail of [
      (h: ReturnType<typeof harness>, id: MeetingId) =>
        h.emit({
          type: "meeting.finalizeFailed",
          id,
          reason: "transcript",
          message: "speech model is not downloaded",
        }),
      (h: ReturnType<typeof harness>, id: MeetingId) => h.finalized(id, []),
    ]) {
      const h = harness();
      const id = await h.start();
      await h.segment(id, "mic", 0, TEN_WORDS);
      await h.recorder.pause(id);
      await h.settle();
      await h.recorder.stop(id);
      await h.drained(id);
      await h.drained(id);
      await fail(h, id);
      await h.settle();
      expect(h.store.get(id)?.status.kind).toBe("ready");
      expect(h.notices).toContain("finalPassFailed");
      expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(true);
      expect(await h.store.transcript(id)).toMatchObject([
        { kind: "segment", text: TEN_WORDS },
        { kind: "marker", marker: "paused" },
      ]);
    }
  });

  test("a start and a resume pressed together record one meeting, not two", async () => {
    const h = harness();
    const finished = await h.start();
    await h.segment(finished, "system", 0, TEN_WORDS);
    await h.recorder.stop(finished);
    await h.finish(finished);
    expect(h.store.get(finished)?.status.kind).toBe("ready");
    const before = h.sent.length;

    const [started, resumed] = await Promise.all([h.recorder.start(), h.recorder.resume(finished)]);
    await h.settle();

    expect(h.sent.slice(before).filter(({ type }) => type === "meeting.start")).toHaveLength(1);
    expect([started.kind, resumed.kind].toSorted()).toEqual(["ok", "refused"]);
  });

  test("a final pass keeps markers and the transcript of audio an earlier pass already deleted", async () => {
    const h = harness();
    const id = await h.start();
    await h.segment(id, "system", 0, TEN_WORDS);
    await h.recorder.stop(id);
    await h.finish(id);
    expect(h.store.get(id)?.speakers).toEqual([]);
    await h.store.update(id, (meeting) => ({
      ...meeting,
      speakers: [{ id: "s1" as SpeakerId, label: "Speaker 1", name: "Ania" }],
    }));
    await h.store.replaceTranscript(id, (meeting, transcript) => ({
      meeting,
      transcript: transcript.map((entry) =>
        entry.kind === "segment" && entry.source === "system"
          ? { ...entry, speakerId: "s1" as SpeakerId }
          : entry,
      ),
    }));

    await h.recorder.resume(id);
    h.emit({ type: "meeting.started", id, atMs: 2000, mic: "active", system: "active" });
    await h.settle();
    await h.audio(id, 1000);
    await h.recorder.stop(id);
    await h.drained(id);
    await h.drained(id);
    expect(h.sent.at(-1)).toMatchObject({ type: "meeting.finalize", baseMs: 2000 });
    await h.finalized(id, [
      { source: "system", startMs: 2100, endMs: 2900, text: "A new voice", speaker: 0 },
    ]);

    expect(h.store.get(id)?.speakers.map(({ id: speaker, name }) => [speaker, name])).toEqual([
      ["s1", "Ania"],
      ["s2", null],
    ]);
    expect(await h.store.transcript(id)).toMatchObject([
      { kind: "segment", speakerId: "s1", text: TEN_WORDS },
      { kind: "marker", marker: "resumed", atMs: 2000 },
      { kind: "segment", speakerId: "s2", text: "A new voice" },
    ]);
  });

  test("after the final pass a meeting over 5 minutes is summarized, a shorter one only gets a title", async () => {
    const calls: string[] = [];
    const outcomes = [true, false];
    const h = harness({
      summarizer: {
        summarizeMeeting: async (id) => {
          calls.push(`summary ${id}`);
          return outcomes.shift() ? { ok: true } : { ok: false, failure: { kind: "rejected" } };
        },
        generateTitle: async (id) => {
          calls.push(`title ${id}`);
          return { ok: true, title: null };
        },
      },
    });
    const long = await h.start();
    await h.segment(long, "mic", 0, TEN_WORDS);
    h.advance(6 * 60_000);
    await h.recorder.stop(long);
    await h.finish(long);
    expect(calls).toEqual([`summary ${long}`]);
    expect(h.store.get(long)?.status.kind).toBe("ready");
    expect(h.notices).toContain("summaryReady");

    const short = await h.start();
    await h.segment(short, "mic", 0, TEN_WORDS);
    h.advance(2 * 60_000);
    await h.recorder.stop(short);
    await h.finish(short);
    expect(h.store.get(short)?.status.kind).toBe("ready");
    expect(calls).toEqual([`summary ${long}`, `title ${short}`]);

    await h.recorder.generateSummary(short);
    await h.settle();
    expect(calls.at(-1)).toBe(`summary ${short}`);
    expect(h.store.get(short)?.status.kind).toBe("ready");
    expect(h.notices).toContain("summaryFailed");
  });

  test("deleting a meeting from the hub stops its summary", async () => {
    let seen: AbortSignal | undefined;
    const h = harness({
      summarizer: {
        summarizeMeeting: (_id, { signal }) => {
          seen = signal;
          return new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason)),
          );
        },
        generateTitle: async () => ({ ok: true, title: null }),
      },
    });
    const id = await h.start();
    await h.segment(id, "mic", 0, TEN_WORDS);
    h.advance(6 * 60_000);
    await h.recorder.stop(id);
    await h.drained(id);
    await h.drained(id);
    // The summary never ends on its own, so this waits for it to start instead of settling.
    h.emit({ type: "meeting.finalized", id, segments: [] });
    await vi.waitFor(() => expect(seen).toBeDefined());

    await h.recorder.remove(id);
    await h.settle();

    expect(seen?.aborted).toBe(true);
    expect(h.store.get(id)).toBeNull();
  });

  test("stop on a paused meeting finishes it, though its capture drained at the pause", async () => {
    const h = harness();
    const id = await h.start();
    await h.segment(id, "mic", 0, TEN_WORDS);
    h.advance(60_000);
    await h.recorder.pause(id);
    await h.settle();
    await h.drained(id);
    expect(h.store.get(id)?.status.kind).toBe("paused");

    await h.recorder.stop(id);
    await h.settle();
    expect(h.sent.at(-1)).toMatchObject({ type: "meeting.transcribe", id, fromMs: { mic: 2000 } });
    await h.drained(id);
    expect(h.sent.at(-1)).toMatchObject({ type: "meeting.finalize", id });
    await h.finalized(id);
    expect(h.store.get(id)?.status.kind).toBe("ready");
  });

  test("the shortcut and the menu bar item finish a paused meeting the same way", async () => {
    const h = harness();
    const id = await h.start();
    await h.segment(id, "mic", 0, TEN_WORDS);
    await h.recorder.pause(id);
    await h.drained(id);
    expect(await h.recorder.toggle()).toEqual({ kind: "ok", id });
    await h.settle();
    expect(h.sent.at(-1)).toMatchObject({ type: "meeting.transcribe", id });
    await h.finish(id);
    expect(h.store.get(id)?.status.kind).toBe("ready");
  });

  test("a live transcript that failed never asks Started by mistake: the final pass decides", async () => {
    const h = harness();
    const id = await h.start();
    await h.segment(id, "mic", 0, "Oops");
    h.advance(60 * 60_000);
    await h.recorder.stop(id);
    await h.drained(id, "speech model is not downloaded");
    expect(h.store.get(id)?.status).toEqual({ kind: "transcribing", step: "finalizing" });
    expect(h.sent.at(-1)).toMatchObject({ type: "meeting.finalize", id });
    expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(true);
    expect(h.logs).toContainEqual(expect.stringContaining("live transcript stalled"));
    await h.finalized(id);
    expect(h.store.get(id)?.status.kind).toBe("ready");

    const short = await h.start();
    await h.segment(short, "mic", 0, "Oops");
    await h.recorder.stop(short);
    await h.drained(short);
    expect(h.store.get(short)?.status).toEqual({ kind: "confirmingShort" });
  });

  test.each([
    ["denied", true, [{ kind: "systemAudioMissing", reason: "permission" }]],
    ["denied", false, [{ kind: "systemAudioMissing", reason: "permission" }]],
    ["unavailable", true, [{ kind: "systemAudioMissing", reason: "device" }]],
    ["unavailable", false, []],
    ["active", true, []],
  ] as const)(
    "system audio %s with support %s tells the user only when the leg lost it",
    async (system, supported, expected) => {
      const h = harness({ systemAudioSupported: () => supported });
      const result = await h.recorder.start();
      if (result.kind !== "ok") throw new Error("start refused");
      h.emit({ type: "meeting.started", id: result.id, atMs: 0, mic: "active", system });
      await h.settle();
      expect(h.store.get(result.id)?.status.kind).toBe("recording");
      expect(h.noticed).toEqual(expected);
    },
  );

  test("a resume whose system audio is missing says so again, once per leg", async () => {
    const h = harness();
    const result = await h.recorder.start();
    if (result.kind !== "ok") throw new Error("start refused");
    const { id } = result;
    h.emit({ type: "meeting.started", id, atMs: 0, mic: "active", system: "denied" });
    await h.settle();
    await h.audio(id);
    await h.recorder.pause(id);
    await h.settle();
    await h.recorder.resume(id);
    await h.settle();
    h.emit({ type: "meeting.started", id, atMs: 100, mic: "active", system: "denied" });
    await h.settle();
    expect(h.noticed).toEqual([
      { kind: "systemAudioMissing", reason: "permission" },
      { kind: "systemAudioMissing", reason: "permission" },
    ]);
  });

  test("a very short recording asks first: discard deletes it, keep finishes it", async () => {
    const h = harness();
    const discarded = await h.start();
    await h.segment(discarded, "mic", 0, "Oops");
    await h.recorder.stop(discarded);
    await h.drained(discarded);
    expect(h.store.get(discarded)?.status.kind).toBe("confirmingShort");
    await h.recorder.discard(discarded);
    await h.settle();
    expect(h.store.get(discarded)).toBeNull();
    expect(existsSync(h.folder(discarded))).toBe(false);
    expect(h.sent.at(-1)).toEqual({ type: "meeting.cancel", id: discarded });

    const kept = await h.start();
    await h.recorder.stop(kept);
    await h.drained(kept);
    await h.recorder.keep(kept);
    await h.settle();
    expect(h.sent.at(-1)).toMatchObject({ type: "meeting.finalize", id: kept });
    await h.finalized(kept);
    expect(h.store.get(kept)?.status.kind).toBe("ready");
  });

  test("a launch finishes a meeting a crash left recording from its files and never records", async () => {
    const first = harness();
    const id = await first.start();
    await first.segment(id, "mic", 0, TEN_WORDS);
    await first.store.settled();

    const h = harness();
    await h.recorder.recover();
    await h.settle();
    expect(h.sentTypes()).toEqual(["meeting.transcribe"]);
    expect(h.sent[0]).toMatchObject({ baseMs: 0, fromMs: { mic: 2000, system: 0 } });
    const meeting = h.store.get(id);
    expect(meeting?.status.kind).toBe("transcribing");
    expect(meeting?.spans).toHaveLength(1);

    await h.drained(id);
    await h.finalized(id);
    expect(h.store.get(id)?.status.kind).toBe("ready");
    expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(false);
    expect(h.sentTypes()).not.toContain("meeting.start");
  });

  test("recovery waits for the helper and sends the final pass once it is ready", async () => {
    const first = harness();
    const id = await first.start();
    await first.store.settled();

    const h = harness();
    h.setHelperRunning(false);
    await h.recorder.recover();
    await h.settle();
    expect(h.sent).toEqual([]);
    h.setHelperRunning(true);
    h.emit({ type: "ready", version: 18 });
    await h.settle();
    expect(h.sentTypes()).toEqual(["meeting.transcribe"]);
    expect(h.sent[0]).toMatchObject({ id });

    // A helper that restarts mid-pass is asked for the pass again, not the drain.
    await h.drained(id);
    h.emit({ type: "ready", version: 18 });
    await h.settle();
    expect(h.sentTypes()).toEqual(["meeting.transcribe", "meeting.finalize", "meeting.finalize"]);
  });

  test("the toggle starts a meeting, waits while it starts, then stops it", async () => {
    const h = harness();
    const started = await h.recorder.toggle();
    if (started.kind !== "ok") throw new Error("the toggle did not start a meeting");
    expect(await h.recorder.toggle()).toEqual({
      kind: "refused",
      message: "The meeting is still starting.",
    });
    expect(h.sentTypes()).toEqual(["meeting.start"]);

    h.emit({ type: "meeting.started", id: started.id, atMs: 0, mic: "active", system: "active" });
    await h.settle();
    expect(await h.recorder.toggle()).toEqual({ kind: "ok", id: started.id });
    expect(h.store.get(started.id)?.status.kind).toBe("finishing");
    expect(h.sentTypes()).toEqual(["meeting.start", "meeting.stop"]);
  });

  test("the toggle stops a paused meeting instead of starting another", async () => {
    const h = harness();
    const id = await h.start();
    await h.recorder.pause(id);
    expect(await h.recorder.toggle()).toEqual({ kind: "ok", id });
    expect(h.store.get(id)?.status.kind).toBe("finishing");
    expect(h.store.state().meetings).toHaveLength(1);
  });

  test("two presses at once start one meeting", async () => {
    const h = harness();
    const results = await Promise.all([h.recorder.toggle(), h.recorder.start()]);
    expect(results.map(({ kind }) => kind)).toEqual(["ok", "refused"]);
    expect(h.sentTypes()).toEqual(["meeting.start"]);
    expect(h.store.state().meetings).toHaveLength(1);
  });

  test("a press during launch starts a new meeting and leaves the one recovery finishes", async () => {
    const first = harness();
    const left = await first.start();
    await first.store.settled();

    const h = harness();
    h.advance(60_000);
    const recovering = h.recorder.recover();
    const pressed = await h.recorder.toggle();
    await recovering;
    await h.settle();
    if (pressed.kind !== "ok") throw new Error("the press did not start a meeting");
    expect(pressed.id).not.toBe(left);
    expect(h.store.get(left)?.status.kind).toBe("transcribing");
    expect(h.sent.map((command) => [command.type, "id" in command && command.id])).toEqual([
      ["meeting.transcribe", left],
      ["meeting.start", pressed.id],
    ]);
  });

  test("a helper exit mid-meeting pauses it with a gap, and resume starts a new leg", async () => {
    const h = harness();
    const id = await h.start();
    h.advance(30_000);
    await h.audio(id, 30_000);
    h.recorder.helperExited();
    await h.settle();
    expect(h.store.get(id)?.status.kind).toBe("paused");
    expect(h.notices).toContain("captureLost");
    expect(await h.store.transcript(id)).toEqual([{ kind: "marker", marker: "gap", atMs: 30_000 }]);
  });

  test("a source lost mid-meeting pauses it with an Audio lost marker and records nothing more", async () => {
    const h = harness();
    const id = await h.start();
    await h.audio(id, 20_000);
    h.emit({ type: "meeting.lost", id, source: "mic", reason: "permission" });
    await h.settle();
    expect(h.store.get(id)?.status).toEqual({ kind: "paused" });
    expect(h.notices).toEqual(["captureLost"]);
    expect(await h.store.transcript(id)).toEqual([{ kind: "marker", marker: "gap", atMs: 20_000 }]);
    expect(h.sentTypes()).toEqual(["meeting.start"]);
  });

  test("dictating mid-meeting leaves a dictated marker and asks nothing of the helper", async () => {
    const h = harness();
    const id = await h.start();
    h.advance(42_000);
    await h.audio(id, 42_000);
    const before = h.sent.length;
    h.emit({
      type: "capture.started",
      id: "dictation-1",
      startMs: 30,
      relayMs: null,
      asrState: "warm",
    });
    await h.settle();
    expect(h.sent).toHaveLength(before);
    expect(await h.store.transcript(id)).toEqual([
      { kind: "marker", marker: "dictated", atMs: 42_000 },
    ]);
  });

  test("warns before the max length, then stops", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    await h.store.updateSettings({ maxLength: "30m", silencePrompt: false });
    const id = await h.start();

    h.advance(30 * 60_000);
    await vi.advanceTimersByTimeAsync(30 * 60_000 - maxLengthWarningMs("30m"));
    await h.settle();
    expect(h.notices).toContain("maxLengthSoon");
    await vi.advanceTimersByTimeAsync(maxLengthWarningMs("30m"));
    await h.settle();
    expect(h.notices).toContain("maxLengthReached");
    expect(h.sent.at(-1)).toEqual({ type: "meeting.stop", id });
    expect(h.store.get(id)?.status.kind).toBe("finishing");
  });

  test("markers sit at the end of the recorded audio, so they sort among segments at any playback speed", async () => {
    const h = harness();
    const id = await h.start();
    // Fixture playback runs 8x: one wall-clock second records eight seconds of audio.
    h.advance(1000);
    await h.audio(id, 8000);
    await h.segment(id, "mic", 5000, "Before the pause");
    await h.recorder.pause(id);
    await h.settle();
    h.advance(1000);
    await h.recorder.resume(id);
    h.emit({ type: "meeting.started", id, atMs: 8000, mic: "active", system: "active" });
    await h.settle();
    await h.audio(id, 16_000);
    await h.segment(id, "mic", 9000, "After the resume");

    const order = (await h.store.transcript(id)).map((entry) =>
      entry.kind === "marker" ? entry.marker : entry.text,
    );
    expect(order).toEqual(["Before the pause", "paused", "resumed", "After the resume"]);
    expect(await h.store.transcript(id)).toContainEqual({
      kind: "marker",
      marker: "paused",
      atMs: 8000,
    });
  });

  test("a resume after the audio was deleted starts new files after everything transcribed", async () => {
    const h = harness();
    const id = await h.start();
    h.advance(10_000);
    await h.audio(id, 80_000);
    await h.segment(id, "mic", 70_000, TEN_WORDS);
    await h.recorder.stop(id);
    await h.finish(id);
    expect(h.store.get(id)?.status.kind).toBe("ready");

    await h.recorder.resume(id);
    await h.settle();
    expect(h.sent.at(-1)).toMatchObject({ type: "meeting.start", baseMs: 72_000 });
  });

  test("a resume after the audio was deleted starts new files at the time recorded so far", async () => {
    const h = harness();
    const id = await h.start();
    await h.segment(id, "mic", 0, TEN_WORDS);
    h.advance(90_000);
    await h.recorder.stop(id);
    await h.finish(id);
    expect(h.store.get(id)?.status.kind).toBe("ready");

    await h.recorder.resume(id);
    await h.settle();
    expect(h.sent.at(-1)).toMatchObject({ type: "meeting.start", baseMs: 90_000 });
  });

  test("deleting a meeting that records stops its capture, its timers and its folder", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    const id = await h.start();
    await h.recorder.remove(id);
    await h.settle();
    expect(h.sentTypes()).toEqual(["meeting.start", "meeting.cancel"]);
    expect(h.store.get(id)).toBeNull();
    expect(existsSync(h.folder(id))).toBe(false);
    // No timer of the deleted meeting fires into a new one.
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    await h.settle();
    expect(h.notices).toEqual([]);
    expect(h.sentTypes()).toEqual(["meeting.start", "meeting.cancel"]);
    expect((await h.recorder.start()).kind).toBe("ok");
  });

  test("a delete in any status after Stop also cancels whatever the helper still does", async () => {
    const h = harness();
    const id = await h.start();
    await h.segment(id, "mic", 0, TEN_WORDS);
    await h.recorder.stop(id);
    await h.drained(id, null);
    expect(h.store.get(id)?.status.kind).toBe("transcribing");
    await h.recorder.remove(id);
    await h.settle();
    expect(h.sent.at(-1)).toEqual({ type: "meeting.cancel", id });
    // A pass that finishes anyway changes nothing.
    await h.finalized(id, []);
    expect(h.store.get(id)).toBeNull();
  });

  test("a resume whose start times out stops the capture it asked for, even when it starts late", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    const id = await h.start();
    await h.recorder.pause(id);
    await h.drained(id);
    await h.recorder.resume(id);
    await h.settle();
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS);
    await h.settle();
    expect(h.store.get(id)?.status).toEqual({ kind: "paused" });
    expect(h.notices).toEqual(["resumeFailed"]);
    expect(h.sentTypes()).toEqual([
      "meeting.start",
      "meeting.stop",
      "meeting.start",
      "meeting.stop",
    ]);

    h.emit({ type: "meeting.started", id, atMs: 0, mic: "active", system: "active" });
    await h.settle();
    expect(h.store.get(id)?.status).toEqual({ kind: "paused" });
    expect(h.sent.at(-1)).toEqual({ type: "meeting.stop", id });
  });

  test("a start whose meeting was given up on is cancelled when it comes back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    const result = await h.recorder.start();
    if (result.kind !== "ok") throw new Error("start refused");
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS);
    await h.settle();
    expect(h.store.get(result.id)).toBeNull();
    expect(h.notices).toEqual(["startFailed"]);
    h.emit({ type: "meeting.started", id: result.id, atMs: 0, mic: "active", system: "active" });
    await h.settle();
    expect(h.sent.at(-1)).toEqual({ type: "meeting.cancel", id: result.id });
  });

  test("a start that fails before it reaches the helper leaves nothing stuck in starting", async () => {
    const h = harness();
    const transcript = h.store.transcript;
    h.store.transcript = async () => {
      throw new Error("EIO");
    };
    expect(await h.recorder.start()).toEqual({
      kind: "refused",
      message: "Recording did not start.",
    });
    await h.settle();
    expect(h.store.state().meetings).toEqual([]);
    expect(h.notices).toEqual(["startFailed"]);
    h.store.transcript = transcript;
    expect((await h.recorder.start()).kind).toBe("ok");
  });

  test("a capture that fails while meeting.json cannot be written still pauses the meeting and tells the user", async () => {
    const h = harness();
    const id = await h.start();
    await readOnly(h.folder(id), async () => {
      h.emit({ type: "meeting.failed", id, message: "the device went away" });
      await h.settle();
      expect(h.store.get(id)?.status).toEqual({ kind: "paused" });
      expect(h.notices).toEqual(["captureLost"]);
      expect((await h.onDisk(id)).status).toEqual({ kind: "recording", since: START });
    });
    await h.recorder.stop(id);
    await h.settle();
    expect(h.store.get(id)?.status).toEqual({ kind: "finishing" });
    expect((await h.onDisk(id)).status).toEqual({ kind: "finishing" });
  });

  test("Stop while meeting.json cannot be written still stops the capture", async () => {
    const h = harness();
    const id = await h.start();
    await readOnly(h.folder(id), async () => {
      expect(await h.recorder.stop(id)).toEqual({ kind: "ok", id });
      await h.settle();
      expect(h.sent.at(-1)).toEqual({ type: "meeting.stop", id });
      expect(h.store.get(id)?.status).toEqual({ kind: "finishing" });
    });
  });

  test("the max length still stops a meeting whose meeting.json cannot be written", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    await h.store.updateSettings({ maxLength: "30m", silencePrompt: false });
    const id = await h.start();
    await readOnly(h.folder(id), async () => {
      h.advance(30 * 60_000);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      await h.settle();
      expect(h.notices).toEqual(["maxLengthSoon", "maxLengthReached"]);
      expect(h.sent.at(-1)).toEqual({ type: "meeting.stop", id });
      expect(h.store.get(id)?.status).toEqual({ kind: "finishing" });
    });
  });

  test("a final pass whose meeting.json cannot be written keeps the audio, and the watchdog ends it as failed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    h.emit({ type: "asr.status", state: "ready", message: null });
    const id = await h.start();
    await h.segment(id, "mic", 0, TEN_WORDS);
    await h.recorder.stop(id);
    await h.drained(id);
    const mic = NodePath.join(h.folder(id), "mic.pcm");
    const replace = h.store.replaceTranscript;
    h.store.replaceTranscript = async (...args) => {
      const replaced = await replace(...args);
      await chmod(h.folder(id), 0o500);
      return replaced;
    };
    try {
      await h.finalized(id);
      expect(h.store.get(id)?.status).toEqual({ kind: "transcribing", step: "finalizing" });
      expect((await h.onDisk(id)).status).toEqual({ kind: "transcribing", step: "finalizing" });
      expect(existsSync(mic)).toBe(true);
      expect(h.logs).not.toContainEqual(expect.stringContaining("deleteAudio"));
    } finally {
      await chmod(h.folder(id), 0o700);
    }
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    await h.settle();
    const failed = { status: { kind: "ready" }, finalPassFailed: "other" };
    expect(h.store.get(id)).toMatchObject(failed);
    expect(await h.onDisk(id)).toMatchObject(failed);
    expect(h.notices).toEqual(["finalPassFailed"]);
    expect(existsSync(mic)).toBe(true);
  });

  test("Delete audio while meeting.json cannot be written is refused and keeps the audio", async () => {
    const h = harness();
    const id = await h.start();
    await h.segment(id, "mic", 0, TEN_WORDS);
    await h.recorder.stop(id);
    await h.drained(id);
    h.emit({ type: "meeting.finalizeFailed", id, reason: "transcript", message: "model missing" });
    await h.settle();
    expect(h.store.get(id)?.finalPassFailed).toBe("other");
    const mic = NodePath.join(h.folder(id), "mic.pcm");
    await readOnly(h.folder(id), async () => {
      await expect(h.recorder.deleteAudio(id)).rejects.toThrow();
      await h.settle();
      expect(h.store.get(id)?.finalPassFailed).toBe("other");
      expect((await h.onDisk(id)).finalPassFailed).toBe("other");
      expect(existsSync(mic)).toBe(true);
    });
  });

  test("a new meeting whose folder cannot be made is refused and asks the helper for nothing", async () => {
    const h = harness();
    await h.store.loaded();
    await readOnly(dir, async () => {
      await expect(h.recorder.start()).rejects.toThrow(/EACCES/);
      await h.settle();
      expect(h.sent).toEqual([]);
      expect(h.store.state().meetings).toEqual([]);
      expect(h.notices).toEqual([]);
    });
  });

  test("a start whose meeting.json write failed keeps its audio and transcript, and a relaunch finishes it", async () => {
    const first = harness();
    const result = await first.recorder.start();
    if (result.kind !== "ok") throw new Error("start refused");
    const { id } = result;
    await first.audio(id, 60_000);
    await meetingWritesFail(first.folder(id), async () => {
      first.emit({ type: "meeting.started", id, atMs: 0, mic: "active", system: "active" });
      await first.settle();
    });
    expect(first.store.get(id)?.status).toEqual({ kind: "recording", since: START });
    expect((await first.onDisk(id)).status).toEqual({ kind: "starting", from: "new" });
    await first.segment(id, "mic", 0, TEN_WORDS);

    const h = harness();
    h.advance(60 * 60_000);
    await h.recorder.recover();
    await h.settle();
    const recovered = h.store.get(id);
    expect(recovered?.status).toEqual({ kind: "transcribing", step: "draining" });
    expect(recovered?.spans).toHaveLength(1);
    expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(true);
    expect(await h.store.transcript(id)).toMatchObject([{ kind: "segment", text: TEN_WORDS }]);
    expect(h.sentTypes()).toEqual(["meeting.transcribe"]);
    await h.drained(id);
    await h.finalized(id);
    expect(h.store.get(id)).toMatchObject({ status: { kind: "ready" }, finalPassFailed: null });
    expect(await h.store.transcript(id)).toMatchObject([{ kind: "segment", text: TEN_WORDS }]);
  });

  test("a resumed leg whose meeting.json write failed keeps its audio, and a relaunch finishes it", async () => {
    const first = harness();
    const id = await first.start();
    await first.segment(id, "mic", 0, TEN_WORDS);
    await first.recorder.stop(id);
    await first.finish(id);
    expect(first.store.get(id)?.status.kind).toBe("ready");
    expect(existsSync(NodePath.join(first.folder(id), "mic.pcm"))).toBe(false);

    first.advance(60_000);
    expect(await first.recorder.resume(id)).toEqual({ kind: "ok", id });
    await first.settle();
    await first.audio(id, 60_000);
    await meetingWritesFail(first.folder(id), async () => {
      first.emit({ type: "meeting.started", id, atMs: 60_000, mic: "active", system: "active" });
      await first.settle();
    });
    expect(first.store.get(id)?.status.kind).toBe("recording");
    expect((await first.onDisk(id)).status).toEqual({ kind: "starting", from: "ready" });
    await first.segment(id, "mic", 60_000, "second leg words");

    const h = harness();
    h.advance(60 * 60_000);
    await h.recorder.recover();
    await h.settle();
    expect(h.store.get(id)?.status).toEqual({ kind: "transcribing", step: "draining" });
    expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(true);
    expect(h.sentTypes()).toEqual(["meeting.transcribe"]);
    await h.drained(id);
    await h.finalized(id);
    expect(h.store.get(id)).toMatchObject({ status: { kind: "ready" }, finalPassFailed: null });
    expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(false);
    expect((await h.store.transcript(id)).map((entry) => entry.kind)).toContain("segment");
  });

  test("a resume that never started on a meeting with kept audio is finished again by a relaunch", async () => {
    const first = harness();
    const id = await first.start();
    await first.segment(id, "mic", 0, TEN_WORDS);
    await first.recorder.stop(id);
    await first.drained(id);
    first.emit({ type: "meeting.finalizeFailed", id, reason: "transcript", message: "no model" });
    await first.settle();
    expect(first.store.get(id)).toMatchObject({
      status: { kind: "ready" },
      finalPassFailed: "other",
    });
    expect(await first.recorder.resume(id)).toEqual({ kind: "ok", id });
    await first.settle();
    expect((await first.onDisk(id)).status).toEqual({ kind: "starting", from: "ready" });

    const h = harness();
    h.advance(60 * 60_000);
    await h.recorder.recover();
    await h.settle();
    expect(h.store.get(id)?.status).toEqual({ kind: "transcribing", step: "draining" });
    expect(h.sent[0]).toMatchObject({
      type: "meeting.transcribe",
      fromMs: { mic: 2000, system: 0 },
    });
    await h.drained(id);
    expect(h.sent.at(-1)).toMatchObject({ type: "meeting.finalize", id });
    await h.finalized(id);
    expect(h.store.get(id)).toMatchObject({ status: { kind: "ready" }, finalPassFailed: null });
    expect(h.store.get(id)?.spans).toHaveLength(2);
    expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(false);
    expect(h.sentTypes()).not.toContain("meeting.start");
  });

  test("a start that never recorded is still removed by a relaunch", async () => {
    const first = harness();
    const result = await first.recorder.start();
    if (result.kind !== "ok") throw new Error("start refused");
    await first.store.settled();
    expect(existsSync(first.folder(result.id))).toBe(true);

    const h = harness();
    await h.recorder.recover();
    await h.settle();
    expect(h.store.get(result.id)).toBeNull();
    expect(existsSync(h.folder(result.id))).toBe(false);
    expect(h.sentTypes()).toEqual(["meeting.cancel"]);
  });

  test("a resume whose meeting.json write fails records nothing, stays ready and rejects", async () => {
    const h = harness();
    const id = await h.start();
    await h.segment(id, "mic", 0, TEN_WORDS);
    await h.recorder.stop(id);
    await h.finish(id);
    expect(h.store.get(id)?.status.kind).toBe("ready");
    const before = h.sent.length;
    await meetingWritesFail(h.folder(id), async () => {
      await expect(h.recorder.resume(id)).rejects.toThrow();
      await h.settle();
      expect(h.sent.slice(before)).toEqual([]);
      expect(h.store.get(id)?.status).toEqual({ kind: "ready" });
      expect((await h.onDisk(id)).status).toEqual({ kind: "ready" });
      expect(existsSync(NodePath.join(h.folder(id), "audio.json"))).toBe(false);
    });
  });

  test("live lines that could not be saved never ask Started by mistake, and an empty final pass keeps the audio", async () => {
    const h = harness();
    const id = await h.start();
    const transcript = NodePath.join(h.folder(id), "transcript.ndjson");
    await writeFile(transcript, "", { mode: 0o400 });
    try {
      await h.segment(id, "mic", 0, TEN_WORDS);
      expect(h.logs).toContainEqual(expect.stringContaining("saving a segment failed"));
      h.advance(60 * 60_000);
      await h.recorder.stop(id);
      await h.drained(id);
      expect(h.store.get(id)?.status).toEqual({ kind: "transcribing", step: "finalizing" });
      expect(h.sent.at(-1)).toMatchObject({ type: "meeting.finalize", id });
      await h.finalized(id, []);
      expect(h.store.get(id)).toMatchObject({
        status: { kind: "ready" },
        finalPassFailed: "other",
      });
      expect(h.notices).toContain("finalPassFailed");
      expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(true);
    } finally {
      await chmod(transcript, 0o600);
    }
  });

  test("an empty final pass after a failed live transcript keeps the audio and reports the failure", async () => {
    const h = harness();
    const id = await h.start();
    await h.audio(id, 60 * 60_000);
    h.advance(60 * 60_000);
    await h.recorder.stop(id);
    await h.drained(id, "speech model is not downloaded");
    expect(h.store.get(id)?.status).toEqual({ kind: "transcribing", step: "finalizing" });
    await h.finalized(id, []);
    expect(h.store.get(id)).toMatchObject({ status: { kind: "ready" }, finalPassFailed: "other" });
    expect(h.notices).toContain("finalPassFailed");
    expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(true);
    expect(await h.recorder.retryFinalPass(id)).toEqual({ kind: "ok", id });
  });

  test("an empty final pass after a drain the watchdog gave up on keeps the audio", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    h.emit({ type: "asr.status", state: "ready", message: null });
    const id = await h.start();
    await h.audio(id, 60 * 60_000);
    h.advance(60 * 60_000);
    await h.recorder.stop(id);
    await h.settle();
    await vi.advanceTimersByTimeAsync(TRANSCRIBE_IDLE_MS + 1000);
    await h.settle();
    expect(h.store.get(id)?.status).toEqual({ kind: "transcribing", step: "finalizing" });
    await h.finalized(id, []);
    expect(h.store.get(id)).toMatchObject({ status: { kind: "ready" }, finalPassFailed: "other" });
    expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(true);
  });

  test("Try again after a relaunch keeps the audio when the final pass is empty again", async () => {
    const first = harness();
    const id = await first.start();
    await first.audio(id, 60 * 60_000);
    first.advance(60 * 60_000);
    await first.recorder.stop(id);
    await first.drained(id, "speech model is not downloaded");
    await first.finalized(id, []);
    expect(first.store.get(id)?.finalPassFailed).toBe("other");
    await first.store.settled();

    const h = harness();
    await h.store.loaded();
    await h.recorder.recover();
    await h.settle();
    expect(await h.recorder.retryFinalPass(id)).toEqual({ kind: "ok", id });
    await h.settle();
    await h.finalized(id, []);
    expect(h.store.get(id)).toMatchObject({ status: { kind: "ready" }, finalPassFailed: "other" });
    expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(true);
  });

  test("a relaunch after a resume that never started keeps kept audio through an empty pass", async () => {
    const first = harness();
    const id = await first.start();
    await first.audio(id, 60 * 60_000);
    first.advance(60 * 60_000);
    await first.recorder.stop(id);
    await first.drained(id, "speech model is not downloaded");
    await first.finalized(id, []);
    await first.recorder.resume(id);
    await first.settle();
    await first.store.settled();

    const h = harness();
    await h.store.loaded();
    await h.recorder.recover();
    await h.settle();
    await h.drained(id);
    await h.finalized(id, []);
    expect(h.store.get(id)).toMatchObject({ status: { kind: "ready" }, finalPassFailed: "other" });
    expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(true);
  });

  test("a last line that fails to save just before the drain never asks Started by mistake", async () => {
    const h = harness();
    const id = await h.start();
    await writeFile(NodePath.join(h.folder(id), "transcript.ndjson"), "", { mode: 0o400 });
    try {
      await h.recorder.stop(id);
      await h.settle();
      h.emit({
        type: "meeting.segment",
        id,
        source: "mic",
        startMs: 0,
        endMs: 2000,
        text: TEN_WORDS,
      });
      h.emit({ type: "meeting.drained", id, failure: null });
      await h.settle();
      expect(h.store.get(id)?.status).toEqual({ kind: "transcribing", step: "finalizing" });
      expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(true);
    } finally {
      await chmod(NodePath.join(h.folder(id), "transcript.ndjson"), 0o600);
    }
  });

  test("a last line saved just before the drain counts toward the word count", async () => {
    const h = harness();
    const id = await h.start();
    await h.recorder.stop(id);
    await h.settle();
    h.emit({
      type: "meeting.segment",
      id,
      source: "mic",
      startMs: 0,
      endMs: 2000,
      text: TEN_WORDS,
    });
    h.emit({ type: "meeting.drained", id, failure: null });
    await h.settle();
    expect(h.store.get(id)?.status).toEqual({ kind: "transcribing", step: "finalizing" });
  });

  test("a resume after a whole live transcript needs a new one before an empty pass is believed", async () => {
    const h = harness();
    const id = await h.start();
    await h.recorder.pause(id);
    await h.drained(id);
    await h.recorder.resume(id);
    await h.settle();
    h.emit({ type: "meeting.started", id, atMs: 2000, mic: "active", system: "active" });
    await h.settle();
    await h.recorder.stop(id);
    await h.settle();
    h.emit({ type: "meeting.drained", id, failure: "speech model is not downloaded" });
    await h.settle();
    await h.finalized(id, []);
    expect(h.store.get(id)?.finalPassFailed).toBe("other");
    expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(true);
  });

  test("a pause's drain that lands during the resume does not vouch for the next leg", async () => {
    const h = harness();
    const id = await h.start();
    await h.recorder.pause(id);
    await h.settle();
    await h.recorder.resume(id);
    await h.settle();
    await h.drained(id);
    h.emit({ type: "meeting.started", id, atMs: 2000, mic: "active", system: "active" });
    await h.settle();
    await h.drained(id);
    await h.audio(id, 60 * 60_000);
    await h.recorder.stop(id);
    await h.drained(id, "speech model is not downloaded");
    await h.finalized(id, []);
    expect(h.store.get(id)).toMatchObject({ status: { kind: "ready" }, finalPassFailed: "other" });
    expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(true);
  });

  test("a pause's drain that lands during the resume does not cover a next leg the watchdog gave up on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    h.emit({ type: "asr.status", state: "ready", message: null });
    const id = await h.start();
    await h.recorder.pause(id);
    await h.settle();
    await h.recorder.resume(id);
    await h.settle();
    await h.drained(id);
    h.emit({ type: "meeting.started", id, atMs: 2000, mic: "active", system: "active" });
    await h.settle();
    await h.drained(id);
    await h.audio(id, 60 * 60_000);
    await h.recorder.stop(id);
    await h.settle();
    await vi.advanceTimersByTimeAsync(TRANSCRIBE_IDLE_MS + 1000);
    await h.settle();
    expect(h.store.get(id)?.status).toEqual({ kind: "transcribing", step: "finalizing" });
    await h.finalized(id, []);
    expect(h.store.get(id)?.finalPassFailed).toBe("other");
    expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(true);
  });

  test("a failed drain takes back the clean one before it", async () => {
    const h = harness();
    const id = await h.start();
    await h.recorder.pause(id);
    await h.drained(id);
    await h.recorder.stop(id);
    await h.drained(id, "speech model is not downloaded");
    await h.finalized(id, []);
    expect(h.store.get(id)?.finalPassFailed).toBe("other");
    expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(true);
  });

  test("an early line that failed to save still counts after a later line saves", async () => {
    const h = harness();
    const id = await h.start();
    const transcript = NodePath.join(h.folder(id), "transcript.ndjson");
    await writeFile(transcript, "", { mode: 0o400 });
    await h.segment(id, "mic", 0, TEN_WORDS);
    await chmod(transcript, 0o600);
    await h.segment(id, "mic", 3000, "ok");
    await h.recorder.stop(id);
    await h.drained(id);
    expect(h.store.get(id)?.status).toEqual({ kind: "transcribing", step: "finalizing" });
  });

  test("a quiet leg after a finished meeting finishes normally and keeps the transcript", async () => {
    const h = harness();
    const id = await h.start();
    await h.segment(id, "mic", 0, TEN_WORDS);
    await h.recorder.stop(id);
    await h.finish(id);
    await h.recorder.resume(id);
    await h.settle();
    h.emit({ type: "meeting.started", id, atMs: 3000, mic: "active", system: "active" });
    await h.settle();
    await h.audio(id);
    await h.recorder.stop(id);
    await h.drained(id);
    await h.finalized(id, []);
    expect(h.store.get(id)).toMatchObject({ status: { kind: "ready" }, finalPassFailed: null });
    expect(h.notices).toEqual([]);
    expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(false);
    expect(await h.store.transcript(id)).toContainEqual(
      expect.objectContaining({ text: TEN_WORDS }),
    );
  });

  test("a line that failed is forgotten once a good final pass removed its audio", async () => {
    const h = harness();
    const id = await h.start();
    const transcript = NodePath.join(h.folder(id), "transcript.ndjson");
    await writeFile(transcript, "", { mode: 0o400 });
    await h.segment(id, "mic", 0, TEN_WORDS);
    await chmod(transcript, 0o600);
    await h.recorder.stop(id);
    await h.drained(id);
    await h.finalized(id, [
      { source: "mic", startMs: 0, endMs: 2000, text: TEN_WORDS, speaker: null },
    ]);
    await h.recorder.resume(id);
    await h.settle();
    h.emit({ type: "meeting.started", id, atMs: 3000, mic: "active", system: "active" });
    await h.settle();
    await h.audio(id);
    await h.recorder.stop(id);
    await h.drained(id);
    await h.finalized(id, []);
    expect(h.store.get(id)).toMatchObject({ status: { kind: "ready" }, finalPassFailed: null });
    expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(false);
  });

  test("a line that failed is forgotten once Delete audio removed its audio", async () => {
    const h = harness();
    const id = await h.start();
    const transcript = NodePath.join(h.folder(id), "transcript.ndjson");
    await writeFile(transcript, "", { mode: 0o400 });
    await h.segment(id, "mic", 0, TEN_WORDS);
    await chmod(transcript, 0o600);
    await h.recorder.stop(id);
    await h.drained(id);
    await h.finalized(id, []);
    expect(h.store.get(id)?.finalPassFailed).toBe("other");
    expect(await h.recorder.deleteAudio(id)).toEqual({ kind: "ok", id });
    await h.settle();
    await h.recorder.resume(id);
    await h.settle();
    h.emit({ type: "meeting.started", id, atMs: 3000, mic: "active", system: "active" });
    await h.settle();
    await h.audio(id);
    await h.recorder.stop(id);
    await h.drained(id);
    expect(h.store.get(id)?.status).toEqual({ kind: "confirmingShort" });
  });

  test("an empty final pass over a silent meeting the live transcript heard whole finishes it and deletes the audio", async () => {
    const h = harness();
    const id = await h.start();
    await h.recorder.stop(id);
    await h.drained(id);
    expect(h.store.get(id)?.status).toEqual({ kind: "confirmingShort" });
    await h.recorder.keep(id);
    await h.settle();
    await h.finalized(id, []);
    expect(h.store.get(id)).toMatchObject({ status: { kind: "ready" }, finalPassFailed: null });
    expect(h.notices).toEqual([]);
    expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(false);
  });

  test("a final pass does not time out while speech recognition is still loading", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = harness();
    const id = await first.start();
    await first.segment(id, "mic", 0, TEN_WORDS);
    await first.store.settled();

    const h = harness();
    await h.recorder.recover();
    await h.settle();
    h.emit({ type: "asr.status", state: "loading", message: null });
    await vi.advanceTimersByTimeAsync(5 * TRANSCRIBE_IDLE_MS);
    await h.settle();
    expect(h.store.get(id)?.status).toEqual({ kind: "transcribing", step: "draining" });
    expect(h.notices).toEqual([]);

    h.emit({ type: "asr.status", state: "ready", message: null });
    await h.drained(id);
    await h.finalized(id);
    expect(h.store.get(id)?.status.kind).toBe("ready");
    expect(h.store.get(id)?.finalPassFailed).toBeNull();
    expect(h.notices).not.toContain("finalPassFailed");
  });

  test("a final pass that never reports fails once recognition could have run it, and keeps the audio", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    h.emit({ type: "asr.status", state: "ready", message: null });
    const id = await h.start();
    await h.segment(id, "mic", 0, TEN_WORDS);
    await h.recorder.stop(id);
    await h.drained(id);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    await h.settle();
    expect(h.store.get(id)?.finalPassFailed).toBe("other");
    expect(h.notices).toEqual(["finalPassFailed"]);
    expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(true);
  });

  test("a failed final pass can be tried again, or its audio deleted, after a relaunch too", async () => {
    const first = harness();
    const id = await first.start();
    await first.segment(id, "mic", 0, TEN_WORDS);
    await first.recorder.stop(id);
    await first.drained(id);
    first.emit({
      type: "meeting.finalizeFailed",
      id,
      reason: "speakerModels",
      message: "speaker detection not downloaded",
    });
    await first.settle();
    expect(first.store.get(id)?.finalPassFailed).toBe("speakerModels");

    // The reason outlives the relaunch, so its notice still says to download speaker detection.
    const h = harness();
    await h.store.loaded();
    expect(h.store.get(id)?.finalPassFailed).toBe("speakerModels");
    expect(await h.recorder.retryFinalPass(id)).toEqual({ kind: "ok", id });
    await h.settle();
    expect(h.sentTypes()).toEqual(["meeting.finalize"]);
    h.emit({ type: "meeting.finalizeFailed", id, reason: "speakers", message: "diarizer crashed" });
    await h.settle();
    expect(h.store.get(id)?.finalPassFailed).toBe("other");

    expect(await h.recorder.deleteAudio(id)).toEqual({ kind: "ok", id });
    await h.settle();
    expect(h.store.get(id)?.finalPassFailed).toBeNull();
    for (const name of ["mic.pcm", "system.pcm", "audio.json"]) {
      expect(existsSync(NodePath.join(h.folder(id), name)), name).toBe(false);
    }
    expect(await h.store.transcript(id)).toMatchObject([{ kind: "segment", text: TEN_WORDS }]);
    expect(await h.recorder.deleteAudio(id)).toEqual({
      kind: "refused",
      message: "There is no kept audio to delete.",
    });
  });

  test("live lines that arrive after the meeting finished are not appended", async () => {
    const h = harness();
    const id = await h.start();
    await h.segment(id, "mic", 0, TEN_WORDS);
    await h.recorder.stop(id);
    await h.finish(id);
    expect(h.store.get(id)?.status.kind).toBe("ready");
    const before = await h.store.transcript(id);
    await h.segment(id, "system", 9000, "late line");
    expect(await h.store.transcript(id)).toEqual(before);
  });

  test("starting a meeting keeps one still asking whether it started by mistake", async () => {
    const h = harness();
    const short = await h.start();
    await h.recorder.stop(short);
    await h.drained(short);
    expect(h.store.get(short)?.status.kind).toBe("confirmingShort");
    const next = await h.start();
    expect(next).not.toBe(short);
    expect(h.store.get(short)?.status).toEqual({ kind: "transcribing", step: "finalizing" });
  });

  test("an unanswered silence prompt stops the recording, and speech or a yes keeps it going", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    const id = await h.start();
    const at = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      await h.settle();
    };
    await at(SILENCE_PROMPT_MS);
    await h.segment(id, "system", 0, "still here");
    await at(SILENCE_STOP_MS);
    expect(h.store.get(id)?.status.kind).toBe("recording");

    await at(SILENCE_PROMPT_MS - SILENCE_STOP_MS);
    h.recorder.keepRecording(id);
    await at(SILENCE_STOP_MS);
    expect(h.store.get(id)?.status.kind).toBe("recording");

    await at(SILENCE_PROMPT_MS);
    expect(h.store.get(id)?.status.kind).toBe("finishing");
    expect(h.notices).toEqual(["silence", "silence", "silence", "silenceStopped"]);
  });

  test("summary progress shows on the meeting, and closing Voice stops a summary without failing it", async () => {
    const { promise: running, resolve: started } = Promise.withResolvers<void>();
    const h = harness({
      summarizer: {
        summarizeMeeting: async (_id, { signal, onProgress }) => {
          onProgress?.({ step: 1, total: 2 });
          started();
          await new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason)),
          );
          return { ok: true };
        },
        generateTitle: async () => ({ ok: true, title: null }),
      },
    });
    const id = await h.start();
    h.advance(6 * 60_000);
    await h.segment(id, "mic", 0, TEN_WORDS);
    await h.recorder.stop(id);
    await h.drained(id);
    h.emit({ type: "meeting.finalized", id, segments: [] });
    await running;
    h.recorder.dispose();
    await h.settle();
    expect(h.store.get(id)?.status).toEqual({
      kind: "summarizing",
      progress: { step: 1, total: 2 },
    });
    expect(h.store.get(id)?.summary).toEqual({ kind: "none" });
  });
});

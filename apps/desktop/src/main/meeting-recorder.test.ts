import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { MeetingId, MeetingNotice, SpeakerId, TranscriptEntry } from "../shared/meetings.ts";
import { MAX_LENGTH_WARNING_MS, SILENCE_PROMPT_MS } from "./meeting-lifecycle.ts";
import type { FinalSegment } from "./meeting-final-pass.ts";
import { createMeetingRecorder, type MeetingRecorderDeps } from "./meeting-recorder.ts";
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

function harness(overrides: Partial<MeetingRecorderDeps> = {}) {
  let clock = START;
  const store = createMeetingsStore({ dir, log: () => {}, onChange: () => {}, now: () => clock });
  const sent: HelperCommand[] = [];
  const pushed: TranscriptEntry[] = [];
  const notices: MeetingNotice["kind"][] = [];
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
    onTranscript: (_id, entries) => pushed.push(...entries),
    onNotice: (_id, notice) => notices.push(notice.kind),
    summarizer: {
      summarizeMeeting: async () => ({ ok: true }),
      generateTitle: async () => ({ ok: true, title: null }),
    },
    log: () => {},
    now: () => clock,
    ...overrides,
  });
  const h = {
    store,
    recorder,
    sent,
    pushed,
    notices,
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
    /** Stop, then the live tail, then the final pass. */
    async finish(id: MeetingId) {
      await h.drained(id);
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
      { kind: "segment", source: "mic", startMs: 0, text: "Hello everyone", final: true },
      { kind: "segment", source: "system", speakerId: null, startMs: 2500, text: "Hi there" },
    ]);
    expect(h.pushed).toEqual(transcript);
  });

  test("a second start while one records is refused and records nothing", async () => {
    const h = harness();
    await h.start();
    expect(await h.recorder.start()).toEqual({
      kind: "refused",
      message: "A meeting is already recording.",
    });
    expect(h.sentTypes()).toEqual(["meeting.start"]);
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
    h.emit({ type: "meeting.started", id, atMs: 0, mic: "active", system: "unavailable" });
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
    expect(h.store.get(id)?.status.kind).toBe("transcribing");
    expect(h.sent.at(-1)).toMatchObject({ type: "meeting.transcribe", fromMs: { mic: 2000 } });

    await h.drained(id);
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

  test("a final pass keeps markers and the transcript of audio an earlier pass already deleted", async () => {
    const h = harness();
    const id = await h.start();
    await h.segment(id, "system", 0, TEN_WORDS);
    await h.recorder.stop(id);
    await h.finish(id);
    expect(h.store.get(id)?.speakers).toEqual([]);
    await h.store.update(id, (meeting) => ({
      ...meeting,
      speakers: [
        { id: "s1" as SpeakerId, label: "Speaker 1", name: { text: "Ania", source: "user" } },
      ],
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
    h.emit({ type: "meeting.started", id, atMs: 0, mic: "active", system: "active" });
    await h.settle();
    await h.audio(id, 1000);
    await h.recorder.stop(id);
    await h.drained(id);
    await h.drained(id);
    expect(h.sent.at(-1)).toMatchObject({ type: "meeting.finalize", baseMs: 2000 });
    await h.finalized(id, [
      { source: "system", startMs: 2100, endMs: 2900, text: "A new voice", speaker: 0 },
    ]);

    expect(h.store.get(id)?.speakers.map(({ id: speaker, name }) => [speaker, name?.text])).toEqual(
      [
        ["s1", "Ania"],
        ["s2", undefined],
      ],
    );
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
    expect(h.store.get(id)?.status.kind).toBe("transcribing");
    await h.drained(id);
    expect(h.sent.at(-1)).toMatchObject({ type: "meeting.finalize", id });
    await h.finalized(id);
    expect(h.store.get(id)?.status.kind).toBe("ready");
  });

  test("a final transcription that fails keeps the audio and the transcript", async () => {
    const h = harness();
    const id = await h.start();
    await h.segment(id, "mic", 0, TEN_WORDS);
    await h.recorder.stop(id);
    await h.drained(id);
    await h.drained(id, "speech model is not downloaded");
    expect(h.store.get(id)?.status.kind).toBe("ready");
    expect(h.notices).toContain("finalPassFailed");
    expect(existsSync(NodePath.join(h.folder(id), "mic.pcm"))).toBe(true);
    expect(await h.store.transcript(id)).toHaveLength(1);
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
    expect(h.sent.at(-1)).toMatchObject({ type: "meeting.transcribe", id: kept });
    await h.drained(kept);
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

  test("warns before the max length, then stops; ten silent minutes prompt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    await h.store.updateSettings({ maxLength: "30m" });
    const id = await h.start();

    await vi.advanceTimersByTimeAsync(SILENCE_PROMPT_MS);
    await h.settle();
    expect(h.notices).toEqual(["silence"]);

    h.advance(30 * 60_000);
    await vi.advanceTimersByTimeAsync(30 * 60_000 - SILENCE_PROMPT_MS - MAX_LENGTH_WARNING_MS);
    await h.settle();
    expect(h.notices).toContain("maxLengthSoon");
    await vi.advanceTimersByTimeAsync(MAX_LENGTH_WARNING_MS);
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
    h.emit({ type: "meeting.started", id, atMs: 0, mic: "active", system: "active" });
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
});

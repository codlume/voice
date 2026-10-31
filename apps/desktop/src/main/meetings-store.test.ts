import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import {
  applyMeetingsChange,
  renameSpeaker,
  type Meeting,
  type MeetingId,
  type MeetingsChange,
  type MeetingsState,
  type Segment,
  type SpeakerId,
  type TranscriptEntry,
} from "../shared/meetings.ts";
import { createMeetingsStore, type MeetingsStore } from "./meetings-store.ts";

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 31, 9, 0);
const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
] as MeetingId[];
const [A, B, C] = ids as [MeetingId, MeetingId, MeetingId];

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(NodePath.join(tmpdir(), "voice-meetings-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const seed = (store: MeetingsStore, saved: Meeting) => store.upsert(saved.id, () => saved);

function meeting(id: MeetingId, overrides: Partial<Meeting> = {}): Meeting {
  return {
    id,
    title: "Weekly sync",
    createdAt: START,
    spans: [{ startedAt: START, endedAt: START + 30 * 60_000 }],
    status: { kind: "ready" },
    folderIds: [],
    notes: "",
    summary: { kind: "none" },
    speakers: [],
    finalPassFailed: false,
    ...overrides,
  };
}

const segment = (id: string, text: string, startMs = 0): Segment => ({
  kind: "segment",
  id,
  source: "mic",
  startMs,
  endMs: startMs + 1000,
  text,
});

function harness(options: { now?: number } = {}) {
  const clock = { now: options.now ?? START };
  const logs: string[] = [];
  let hub: MeetingsState | null = null;
  const changes: MeetingsChange[] = [];
  const store = createMeetingsStore({
    dir,
    log: (message) => logs.push(message),
    now: () => clock.now,
    onChange: (change) => {
      changes.push(change);
      hub = applyMeetingsChange(hub, change);
    },
  });
  const loaded = store.loaded().then(() => {
    hub = store.state();
  });
  return { store, clock, logs, changes, loaded, hub: () => hub };
}

async function relaunch(options: { now?: number } = {}) {
  const next = harness(options);
  await next.loaded;
  return next;
}

const rule = (text: string) => ({ kind: "titleContains", text }) as const;
const meetingDir = (id: MeetingId) => NodePath.join(dir, id);
const mode = async (file: string) => (await stat(file)).mode & 0o777;

describe("meetings store", () => {
  test("a meeting and its transcript survive a relaunch", async () => {
    const first = harness();
    await first.loaded;
    const saved = meeting(A, { notes: "Ask about the budget" });
    await seed(first.store, saved);
    await first.store.append(A, [segment("s1", "Hello"), segment("s2", "Budget is fine", 1000)]);
    await first.store.append(A, [{ kind: "marker", marker: "paused", atMs: 2000 }]);

    const second = await relaunch();
    expect(second.store.state().meetings).toEqual([saved]);
    expect(await second.store.transcript(A)).toEqual([
      segment("s1", "Hello"),
      segment("s2", "Budget is fine", 1000),
      { kind: "marker", marker: "paused", atMs: 2000 },
    ]);
  });

  test("a renamed speaker and the segments that name it survive a relaunch", async () => {
    const first = harness();
    await first.loaded;
    const s1 = "s1" as SpeakerId;
    await seed(first.store, meeting(A, { speakers: [{ id: s1, label: "Speaker 1", name: null }] }));
    const said: Segment = { ...segment("x", "Hi"), source: "system", speakerId: s1 };
    await first.store.append(A, [said]);
    await first.store.update(A, (saved) => renameSpeaker(saved, s1, "  Ania "));

    const second = await relaunch();
    expect(second.store.get(A)?.speakers).toEqual([{ id: s1, label: "Speaker 1", name: "Ania" }]);
    expect(await second.store.transcript(A)).toEqual([said]);
  });

  test("files are owner-only and the hub hears each change as a patch", async () => {
    const { store, loaded, changes, hub } = harness();
    await loaded;
    await seed(store, meeting(A));
    await store.append(A, [segment("s1", "Hello")]);
    expect(await mode(meetingDir(A))).toBe(0o700);
    expect(await mode(NodePath.join(meetingDir(A), "meeting.json"))).toBe(0o600);
    expect(await mode(NodePath.join(meetingDir(A), "transcript.ndjson"))).toBe(0o600);
    expect(changes.map((change) => change.kind)).toEqual(["patch"]);
    expect(hub()?.meetings).toEqual([meeting(A)]);
  });

  test("appends grow the file one line per entry, read back in time order", async () => {
    const { store, loaded } = harness();
    await loaded;
    await seed(store, meeting(A));
    const later = { ...segment("s2", "there"), startMs: 2000, endMs: 3000 };
    await store.append(A, [later]);
    await store.append(A, [segment("s1", "Hello")]);
    const file = await readFile(NodePath.join(meetingDir(A), "transcript.ndjson"), "utf8");
    expect(file.trimEnd().split("\n")).toHaveLength(2);
    expect(await store.transcript(A)).toEqual([segment("s1", "Hello"), later]);
  });

  test("a line a crash tore is skipped and the next append does not join it", async () => {
    await mkdir(meetingDir(A), { recursive: true });
    await writeFile(
      NodePath.join(meetingDir(A), "meeting.json"),
      JSON.stringify({ version: 1, meeting: meeting(A) }),
    );
    const file = NodePath.join(meetingDir(A), "transcript.ndjson");
    await writeFile(file, `${JSON.stringify(segment("s1", "Kept"))}\n{"kind":"segm`);
    const { store, loaded } = harness();
    await loaded;
    await store.append(A, [segment("s2", "After the crash", 2000)]);
    expect(await store.transcript(A)).toEqual([
      segment("s1", "Kept"),
      segment("s2", "After the crash", 2000),
    ]);
  });

  test("replacing the transcript swaps in the final pass whole, with its meeting", async () => {
    const { store, loaded, hub } = harness();
    await loaded;
    await seed(store, meeting(A));
    await store.append(A, [segment("live", "helo wrld")]);
    const speakers = [{ id: "s1" as SpeakerId, label: "Speaker 1", name: null }];
    const seen: TranscriptEntry[][] = [];
    const replaced = await store.replaceTranscript(A, (current, transcript) => {
      seen.push(transcript);
      return { meeting: { ...current, speakers }, transcript: [segment("final", "Hello world")] };
    });
    await store.append(A, [{ kind: "marker", marker: "resumed", atMs: 5000 }]);
    expect(replaced).toBe(true);
    expect(seen).toEqual([[segment("live", "helo wrld")]]);
    expect(await store.transcript(A)).toEqual([
      segment("final", "Hello world"),
      { kind: "marker", marker: "resumed", atMs: 5000 },
    ]);
    expect(hub()?.meetings[0]?.speakers).toEqual(speakers);
    expect((await relaunch()).store.get(A)?.speakers).toEqual(speakers);
    expect(await store.replaceTranscript(B, (m) => ({ meeting: m, transcript: [] }))).toBe(false);
  });

  test("interleaved changes each see the one queued before, so none is lost", async () => {
    const { store, loaded } = harness();
    await loaded;
    await seed(store, meeting(A, { status: { kind: "recording", since: START } }));
    const folder = await store.createFolder({ name: "Work", kind: "manual" });
    const s1 = "s1" as SpeakerId;
    await Promise.all([
      store.setInFolder(A, folder.id, true),
      store.update(A, (m) => ({ ...m, notes: "ship it" })),
      store.upsert(A, (m) => m && { ...m, status: { kind: "paused" } }),
      store.update(A, (m) => ({ ...m, title: "Roadmap" })),
      store.upsert(A, (m) => m && { ...m, speakers: [{ id: s1, label: "Speaker 1", name: null }] }),
      store.update(A, (m) => renameSpeaker(m, s1, "Ania")),
    ]);
    const expected = {
      status: { kind: "paused" },
      folderIds: [folder.id],
      notes: "ship it",
      title: "Roadmap",
      speakers: [{ id: s1, label: "Speaker 1", name: "Ania" }],
    };
    expect(store.get(A)).toMatchObject(expected);
    expect((await relaunch()).store.get(A)).toMatchObject(expected);
  });

  test("deleting a meeting removes its folder, audio included, and late writes do not bring it back", async () => {
    const { store, loaded, hub } = harness();
    await loaded;
    await seed(store, meeting(A));
    await writeFile(NodePath.join(meetingDir(A), "mic.pcm"), "audio");
    await store.remove(A);
    expect(existsSync(meetingDir(A))).toBe(false);
    await store.append(A, [segment("s1", "late")]);
    await seed(store, meeting(A));
    expect(existsSync(meetingDir(A))).toBe(false);
    expect(hub()?.meetings).toEqual([]);
  });

  test("the recovery scan returns meetings a crash left mid-lifecycle, with their newest write", async () => {
    const first = harness();
    await first.loaded;
    await seed(first.store, meeting(A, { status: { kind: "recording", since: START }, spans: [] }));
    await seed(first.store, meeting(B, { status: { kind: "paused" } }));
    await seed(first.store, meeting(C));
    const audio = NodePath.join(meetingDir(A), "mic.pcm");
    await writeFile(audio, "audio");
    const audioAt = (await stat(audio)).mtimeMs;

    const second = await relaunch();
    const found = await second.store.unfinished();
    expect(found.map(({ meeting: { id } }) => id).toSorted()).toEqual([A, B]);
    expect(found.find(({ meeting: { id } }) => id === A)?.lastWriteAt).toBeGreaterThanOrEqual(
      audioAt,
    );
  });

  test("retention deletes ready meetings past their window, and only those", async () => {
    const first = harness();
    await first.loaded;
    await seed(first.store, meeting(A));
    await seed(first.store, meeting(B, { status: { kind: "transcribing", step: "finalizing" } }));
    await seed(
      first.store,
      meeting(C, {
        createdAt: START + 20 * DAY,
        spans: [{ startedAt: START + 20 * DAY, endedAt: START + 20 * DAY + 1 }],
      }),
    );
    await first.store.updateSettings({ retention: "week" });
    expect(
      first.store
        .state()
        .meetings.map(({ id }) => id)
        .toSorted(),
    ).toEqual([A, B, C]);

    const later = await relaunch({ now: START + 8 * DAY });
    expect(
      later.store
        .state()
        .meetings.map(({ id }) => id)
        .toSorted(),
    ).toEqual([B, C]);
    expect(existsSync(meetingDir(A))).toBe(false);

    await later.store.updateSettings({ retention: "forever" });
    later.clock.now = START + 400 * DAY;
    await later.store.expire();
    expect(later.store.state().meetings).toHaveLength(2);
  });

  test("forever is the default and keeps old meetings", async () => {
    const first = harness();
    await first.loaded;
    await seed(first.store, meeting(A));
    const later = await relaunch({ now: START + 3000 * DAY });
    expect(later.store.state().settings.retention).toBe("forever");
    expect(later.store.state().meetings).toHaveLength(1);
  });

  test("search finds titles, summaries, notes and full transcripts, ignoring case", async () => {
    const { store, loaded } = harness();
    await loaded;
    await seed(store, meeting(A, { title: "Roadmap review" }));
    await seed(
      store,
      meeting(B, {
        createdAt: START + 1,
        title: null,
        notes: "Remember the hiring plan",
        summary: {
          kind: "ready",
          summary: {
            markdown: "We chose Postgres with {{speaker:you}}.",
            coversUntilMs: 1,
          },
        },
      }),
    );
    await seed(store, meeting(C, { createdAt: START + 2, title: null }));
    await store.append(C, [segment("s1", "The quarterly ROADMAP slipped by a week")]);

    expect(await store.search("roadmap")).toEqual([
      { id: C, field: "transcript", snippet: "The quarterly ROADMAP slipped by a week" },
      { id: A, field: "title", snippet: "Roadmap review" },
    ]);
    expect(await store.search("postgres with you")).toEqual([
      { id: B, field: "summary", snippet: "We chose Postgres with You." },
    ]);
    // Token markup is not text the user wrote.
    expect(await store.search("speaker:")).toEqual([]);
    expect((await store.search("hiring")).map(({ field }) => field)).toEqual(["notes"]);
    expect(await store.search("   ")).toEqual([]);
  });

  test("deleting a folder takes its meetings out of it and keeps them", async () => {
    const first = harness();
    await first.loaded;
    await seed(first.store, meeting(A));
    const folder = await first.store.createFolder({ name: " Clients ", kind: "manual" });
    expect(folder.name).toBe("Clients");
    await first.store.setInFolder(A, folder.id, true);
    expect(first.store.get(A)?.folderIds).toEqual([folder.id]);

    await first.store.removeFolder(folder.id);
    const second = await relaunch();
    expect(second.store.state().folders).toEqual([]);
    expect(second.store.get(A)?.folderIds).toEqual([]);
  });

  test("auto folders keep their rule across a relaunch", async () => {
    const first = harness();
    await first.loaded;
    const folder = await first.store.createFolder({
      name: "1:1s",
      kind: "auto",
      rule: { kind: "titleContains", text: "1:1" },
    });
    const second = await relaunch();
    expect(second.store.state().folders).toEqual([folder]);
  });

  test("a new or edited automatic folder files the existing meetings its rule matches", async () => {
    const first = harness();
    await first.loaded;
    await seed(first.store, meeting(A, { title: "Ana 1:1" }));
    await seed(first.store, meeting(B, { title: "Weekly sync" }));
    await seed(first.store, meeting(C, { title: null }));
    const folder = await first.store.createFolder({
      name: "1:1s",
      kind: "auto",
      rule: rule("1:1"),
    });
    expect(ids.map((id) => first.store.get(id)?.folderIds)).toEqual([[folder.id], [], []]);

    // B is added by hand, then the rule moves from "1:1" to "sync".
    await first.store.setInFolder(C, folder.id, true);
    await first.store.updateFolder(folder.id, { name: "Syncs", kind: "auto", rule: rule("Sync") });
    expect(ids.map((id) => first.store.get(id)?.folderIds)).toEqual([[], [folder.id], [folder.id]]);

    const before = first.changes.length;
    await first.store.updateFolder(folder.id, { name: "Syncs", kind: "auto", rule: rule("Sync") });
    const repeat = first.changes.slice(before);
    expect(repeat.map((change) => change.kind === "patch" && change.upsert.length)).toEqual([0]);

    const second = await relaunch();
    expect(ids.map((id) => second.store.get(id)?.folderIds)).toEqual([
      [],
      [folder.id],
      [folder.id],
    ]);
    expect(second.hub()?.folders).toEqual([{ ...folder, name: "Syncs", rule: rule("Sync") }]);
  });

  test("a folder turned manual keeps its meetings and drops its rule", async () => {
    const first = harness();
    await first.loaded;
    await seed(first.store, meeting(A, { title: "Ana 1:1" }));
    const folder = await first.store.createFolder({
      name: "1:1s",
      kind: "auto",
      rule: { kind: "titleContains", text: "1:1" },
    });
    await first.store.updateFolder(folder.id, { name: "1:1s", kind: "manual" });
    expect(first.store.get(A)?.folderIds).toEqual([folder.id]);
    expect(first.store.state().folders).toEqual([
      { id: folder.id, name: "1:1s", kind: "manual", createdAt: folder.createdAt },
    ]);
  });

  test("turning automatic folders on files existing meetings; off files nothing", async () => {
    const first = harness();
    await first.loaded;
    await first.store.updateSettings({ autoFolders: false });
    await seed(first.store, meeting(A, { title: "Ana 1:1" }));
    const folder = await first.store.createFolder({
      name: "1:1s",
      kind: "auto",
      rule: { kind: "titleContains", text: "1:1" },
    });
    expect(first.store.get(A)?.folderIds).toEqual([]);

    await first.store.updateSettings({ autoFolders: true });
    expect(first.store.get(A)?.folderIds).toEqual([folder.id]);
    expect(first.hub()?.meetings.find(({ id }) => id === A)?.folderIds).toEqual([folder.id]);

    await first.store.setInFolder(A, folder.id, false);
    await first.store.updateSettings({ autoFolders: true });
    expect(first.store.get(A)?.folderIds).toEqual([]);
    await first.store.updateSettings({ autoFolders: false });
    const second = await relaunch();
    expect(second.store.get(A)?.folderIds).toEqual([]);
  });

  test("an unreadable meeting is left alone and never overwritten or expired", async () => {
    await mkdir(meetingDir(A), { recursive: true });
    const file = NodePath.join(meetingDir(A), "meeting.json");
    await writeFile(file, "{ not json");
    const { store, loaded, logs } = harness({ now: START + 3000 * DAY });
    await loaded;
    await store.updateSettings({ retention: "day" });
    expect(store.state().meetings).toEqual([]);
    expect(await readFile(file, "utf8")).toBe("{ not json");
    expect(logs.some((line) => line.includes(A))).toBe(true);
  });

  test("an unreadable folders file is left alone and folder changes are refused", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(NodePath.join(dir, "folders.json"), JSON.stringify({ version: 99 }));
    const { store, loaded } = harness();
    await loaded;
    await expect(store.createFolder({ name: "New", kind: "manual" })).rejects.toThrow();
    expect(JSON.parse(await readFile(NodePath.join(dir, "folders.json"), "utf8"))).toEqual({
      version: 99,
    });
  });

  test("ignores directories and lines that are not meetings", async () => {
    await mkdir(NodePath.join(dir, "not-a-meeting"), { recursive: true });
    const { store, loaded } = harness();
    await loaded;
    await seed(store, meeting(A));
    await appendFile(
      NodePath.join(meetingDir(A), "transcript.ndjson"),
      `${JSON.stringify({ kind: "segment", id: "x" })}\n`,
    );
    const entries: TranscriptEntry[] = await store.transcript(A);
    expect(entries).toEqual([]);
    expect(store.state().meetings.map(({ id }) => id)).toEqual([A]);
  });
});

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import * as NodePath from "node:path";

import {
  DEFAULT_MEETINGS_SETTINGS,
  endedAt,
  sortTranscript,
  markerKinds,
  meetingRetentionMs,
  parseFolderId,
  parseMeetingId,
  parseMeetingsSettingsPatch,
  refile,
  searchMeeting,
  type Folder,
  type FolderDraft,
  type FolderId,
  type FolderKind,
  type Meeting,
  type MeetingId,
  type MeetingSearchHit,
  type MeetingsChange,
  type MeetingsSettings,
  type MeetingsSettingsPatch,
  type MeetingsState,
  type MeetingStatus,
  type Span,
  type Speaker,
  type SpeakerId,
  type Summary,
  type SummaryState,
  type TranscriptEntry,
} from "../shared/meetings.ts";
import { writeFileAtomic } from "./atomic-file.ts";
import type { Log } from "./diagnostics-scrub.ts";

/** A meeting a crash or quit left mid-lifecycle. `lastWriteAt` is the newest file in its folder. */
export type Unfinished = { meeting: Meeting; lastWriteAt: number };

export type MeetingsStore = {
  /** Resolves once the launch read is in and retention has run. */
  loaded(): Promise<void>;
  state(): MeetingsState;
  get(id: MeetingId): Meeting | null;
  /** The transcript as its lines mean it; empty for a meeting with none. */
  transcript(id: MeetingId): Promise<TranscriptEntry[]>;
  /**
   * Changes the meeting, or makes it from null, against the latest copy after every write queued
   * before it, so a change never overwrites one it did not see. Returning the same meeting or null
   * writes nothing; a meeting deleted this run is not brought back.
   */
  upsert(id: MeetingId, change: (meeting: Meeting | null) => Meeting | null): Promise<void>;
  /** Resolves with the changed meeting, or null when there is no such meeting. */
  update(id: MeetingId, change: (meeting: Meeting) => Meeting): Promise<Meeting | null>;
  /** Resolves with the meeting's `transcriptRevision` after the lines, or null when none landed. */
  append(id: MeetingId, entries: readonly TranscriptEntry[]): Promise<number | null>;
  /**
   * Swaps in a whole transcript and the meeting that goes with it, as the final pass does. The
   * transcript is written first, atomically, so a crash between the two leaves a transcript
   * whose new speakers read as Others and a meeting that runs the pass again. False when the
   * meeting is gone.
   */
  replaceTranscript(
    id: MeetingId,
    change: (
      meeting: Meeting,
      transcript: TranscriptEntry[],
    ) => { meeting: Meeting; transcript: readonly TranscriptEntry[] },
  ): Promise<boolean>;
  /** Deletes the meeting's folder: transcript, notes, summary and any audio. */
  remove(id: MeetingId): Promise<void>;
  createFolder(draft: FolderDraft): Promise<Folder>;
  updateFolder(id: FolderId, draft: FolderDraft): Promise<void>;
  /** Removes the folder and takes every meeting out of it. Meetings stay. */
  removeFolder(id: FolderId): Promise<void>;
  setInFolder(meetingId: MeetingId, folderId: FolderId, inFolder: boolean): Promise<void>;
  updateSettings(patch: MeetingsSettingsPatch): Promise<void>;
  search(query: string): Promise<MeetingSearchHit[]>;
  /** Deletes ready meetings older than the retention. The timer runs late after sleep, so wake-ups call this. */
  expire(): Promise<void>;
  unfinished(): Promise<Unfinished[]>;
  settled(): Promise<void>;
};

const VERSION = 1;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const MAX_TIMER_MS = 2 ** 31 - 1;

class LeftAlone extends Error {}

export function createMeetingsStore(options: {
  dir: string;
  log: Log;
  onChange: (change: MeetingsChange) => void;
  now?: () => number;
}): MeetingsStore {
  const { dir, log } = options;
  const now = options.now ?? Date.now;
  const meetingDir = (id: MeetingId) => NodePath.join(dir, id);
  const meetingFile = (id: MeetingId) => NodePath.join(meetingDir(id), "meeting.json");
  const transcriptFile = (id: MeetingId) => NodePath.join(meetingDir(id), "transcript.ndjson");
  const foldersFile = NodePath.join(dir, "folders.json");
  const settingsFile = NodePath.join(dir, "settings.json");

  const meetings = new Map<MeetingId, Meeting>();
  let folders: readonly Folder[] = [];
  let settings = DEFAULT_MEETINGS_SETTINGS;
  // Files this run could not read are never overwritten, so their changes are refused instead.
  const leftAlone = new Set<"folders" | "settings">();
  // Ids deleted this run, so a late segment or save does not bring the folder back.
  const tombstones = new Set<MeetingId>();
  // Transcripts whose last line this run checked, so an append never joins a line a crash tore.
  const appendChecked = new Set<MeetingId>();
  // Meetings this launch found unfinished. Recovery finishes them; retention waits a launch, so
  // a meeting is never deleted the moment it comes back, before the user saw it.
  const recovered = new Set<MeetingId>();
  let ready = false;
  let expiry: NodeJS.Timeout | null = null;
  let queue: Promise<void> = Promise.resolve();

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work);
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  const list = () => [...meetings.values()].toSorted((a, b) => b.createdAt - a.createdAt);
  const state = (): MeetingsState => ({ meetings: list(), folders, settings });

  function publish(upsert: readonly Meeting[], remove: readonly MeetingId[] = []) {
    if (ready) options.onChange({ kind: "patch", upsert, remove, folders, settings });
    scheduleExpiry();
  }

  const envelope = (body: object) => `${JSON.stringify({ version: VERSION, ...body })}\n`;

  async function writeMeeting(meeting: Meeting) {
    await mkdir(meetingDir(meeting.id), { recursive: true, mode: DIR_MODE });
    await writeFileAtomic(meetingFile(meeting.id), envelope({ meeting }), { mode: FILE_MODE });
  }

  async function writeFolders(next: readonly Folder[]) {
    if (leftAlone.has("folders")) throw new Error("The saved folders could not be read.");
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await writeFileAtomic(foldersFile, envelope({ folders: next }), { mode: FILE_MODE });
    folders = next;
  }

  async function readJson(file: string): Promise<Record<string, unknown> | null> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new LeftAlone(`could not read ${NodePath.basename(file)} (${String(error)})`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LeftAlone(`${NodePath.basename(file)} is not JSON`);
    }
    if (!isRecord(parsed)) throw new LeftAlone(`${NodePath.basename(file)} is not an object`);
    if (parsed.version !== VERSION) {
      throw new LeftAlone(`${NodePath.basename(file)} has version ${String(parsed.version)}`);
    }
    return parsed;
  }

  async function loadMeeting(id: MeetingId) {
    try {
      const found = await readJson(meetingFile(id));
      if (found === null) return;
      const meeting = parseMeeting(found.meeting);
      if (meeting === null || meeting.id !== id) throw new LeftAlone("meeting.json is malformed");
      meetings.set(id, meeting);
    } catch (error) {
      if (!(error instanceof LeftAlone)) throw error;
      log(`meetings: ${id} left alone, ${error.message}`);
    }
  }

  async function load() {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const ids = names.flatMap((name) => parseMeetingId(name) ?? []);
    await Promise.all(ids.map(loadMeeting));
    for (const meeting of meetings.values()) {
      if (meeting.status.kind !== "ready") recovered.add(meeting.id);
    }
    try {
      const found = await readJson(foldersFile);
      if (found) folders = parseFolders(found.folders);
    } catch (error) {
      if (!(error instanceof LeftAlone)) throw error;
      leftAlone.add("folders");
      log(`meetings: folders left alone, ${error.message}`);
    }
    try {
      const found = await readJson(settingsFile);
      if (found) settings = { ...settings, ...parseMeetingsSettingsPatch(found.settings) };
    } catch (error) {
      if (!(error instanceof LeftAlone)) throw error;
      leftAlone.add("settings");
      log(`meetings: settings left alone, ${error.message}`);
    }
  }

  function expiresAt(meeting: Meeting): number {
    if (meeting.status.kind !== "ready" || recovered.has(meeting.id)) return Infinity;
    return (endedAt(meeting) ?? meeting.createdAt) + meetingRetentionMs[settings.retention];
  }

  function scheduleExpiry() {
    if (expiry) clearTimeout(expiry);
    expiry = null;
    const next = Math.min(...[...meetings.values()].map(expiresAt));
    if (!Number.isFinite(next)) return;
    expiry = setTimeout(
      () => void expire().catch((error) => log(`meetings: expiry failed (${String(error)})`)),
      Math.min(MAX_TIMER_MS, Math.max(0, next - now())),
    );
    expiry.unref();
  }

  async function removeNow(id: MeetingId) {
    tombstones.add(id);
    await rm(meetingDir(id), { recursive: true, force: true });
    if (meetings.delete(id)) publish([], [id]);
  }

  const expire = () =>
    serial(async () => {
      const cutoff = now();
      const old = [...meetings.values()].filter((meeting) => expiresAt(meeting) <= cutoff);
      for (const { id } of old) await removeNow(id);
      if (old.length > 0)
        log(`meetings: deleted ${old.length} past the ${settings.retention} retention`);
      scheduleExpiry();
    });

  async function readTranscript(id: MeetingId): Promise<TranscriptEntry[]> {
    let text: string;
    try {
      text = await readFile(transcriptFile(id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return sortTranscript(text.split("\n").flatMap(parseLine));
  }

  const loading = serial(async () => {
    await load();
    ready = true;
  }).then(expire);

  // Runs after the folders are written, so no meeting points at a folder that is not saved.
  async function refileMeetings(
    targets: readonly { folder: Folder; before: FolderKind | null }[],
  ): Promise<Meeting[]> {
    if (!settings.autoFolders) return [];
    const changed: Meeting[] = [];
    for (const meeting of meetings.values()) {
      const next = targets.reduce(
        (current, { folder, before }) => refile(current, folder, before),
        meeting,
      );
      if (next === meeting) continue;
      await writeMeeting(next);
      meetings.set(next.id, next);
      changed.push(next);
    }
    return changed;
  }

  return {
    loaded: () => loading,
    state,
    get: (id) => meetings.get(id) ?? null,
    transcript: (id) => readTranscript(id),
    upsert: (id, change) =>
      serial(async () => {
        if (tombstones.has(id)) return;
        const meeting = meetings.get(id) ?? null;
        const next = change(meeting);
        if (next === null || next === meeting) return;
        await writeMeeting(next);
        meetings.set(id, next);
        publish([next]);
      }),
    update: (id, change) =>
      serial(async () => {
        const meeting = meetings.get(id);
        if (!meeting) return null;
        const next = change(meeting);
        if (next === meeting) return meeting;
        await writeMeeting(next);
        meetings.set(id, next);
        publish([next]);
        return next;
      }),
    append: (id, entries) =>
      serial(async () => {
        if (tombstones.has(id) || entries.length === 0) return null;
        const file = transcriptFile(id);
        await mkdir(meetingDir(id), { recursive: true, mode: DIR_MODE });
        const lead = !appendChecked.has(id) && (await tornTail(file)) ? "\n" : "";
        await appendFile(file, lead + lines(entries), { mode: FILE_MODE });
        appendChecked.add(id);
        const meeting = meetings.get(id);
        if (!meeting) return null;
        // Neither written nor published: the caller sends the lines on with this revision, and
        // the next write of the meeting carries it.
        const transcriptRevision = meeting.transcriptRevision + 1;
        meetings.set(id, { ...meeting, transcriptRevision });
        return transcriptRevision;
      }),
    replaceTranscript: (id, change) =>
      serial(async () => {
        const meeting = meetings.get(id);
        if (!meeting) return false;
        const next = change(meeting, await readTranscript(id));
        await writeFileAtomic(transcriptFile(id), lines(next.transcript), { mode: FILE_MODE });
        appendChecked.add(id);
        const rewritten = { ...next.meeting, transcriptRevision: meeting.transcriptRevision + 1 };
        await writeMeeting(rewritten);
        meetings.set(id, rewritten);
        publish([rewritten]);
        return true;
      }),
    remove: (id) => serial(() => removeNow(id)),
    createFolder: (draft) =>
      serial(async () => {
        const folder: Folder = {
          ...cleanDraft(draft),
          id: randomUUID() as FolderId,
          createdAt: now(),
        };
        await writeFolders([...folders, folder]);
        publish(await refileMeetings([{ folder, before: null }]));
        return folder;
      }),
    updateFolder: (id, draft) =>
      serial(async () => {
        const before = folders.find((folder) => folder.id === id);
        if (!before) return;
        // Built from the draft alone, so a folder turned manual drops its old rule.
        const folder: Folder = { ...cleanDraft(draft), id, createdAt: before.createdAt };
        await writeFolders(folders.map((other) => (other.id === id ? folder : other)));
        publish(await refileMeetings([{ folder, before }]));
      }),
    removeFolder: (id) =>
      serial(async () => {
        if (!folders.some((folder) => folder.id === id)) return;
        // Meetings first: a failure there leaves the folder, so no meeting points at nothing.
        const members = [...meetings.values()].filter((meeting) => meeting.folderIds.includes(id));
        const changed: Meeting[] = [];
        for (const meeting of members) {
          const next = { ...meeting, folderIds: meeting.folderIds.filter((other) => other !== id) };
          await writeMeeting(next);
          meetings.set(next.id, next);
          changed.push(next);
        }
        await writeFolders(folders.filter((folder) => folder.id !== id));
        publish(changed);
      }),
    setInFolder: (meetingId, folderId, inFolder) =>
      serial(async () => {
        const meeting = meetings.get(meetingId);
        if (!meeting || !folders.some((folder) => folder.id === folderId)) return;
        if (meeting.folderIds.includes(folderId) === inFolder) return;
        const folderIds = inFolder
          ? [...meeting.folderIds, folderId]
          : meeting.folderIds.filter((id) => id !== folderId);
        const next = { ...meeting, folderIds };
        await writeMeeting(next);
        meetings.set(meetingId, next);
        publish([next]);
      }),
    updateSettings: async (patch) => {
      await serial(async () => {
        if (leftAlone.has("settings"))
          throw new Error("The saved meeting settings could not be read.");
        const next: MeetingsSettings = { ...settings, ...patch };
        await mkdir(dir, { recursive: true, mode: DIR_MODE });
        await writeFileAtomic(settingsFile, envelope({ settings: next }), { mode: FILE_MODE });
        const turnedOn = next.autoFolders && !settings.autoFolders;
        settings = next;
        const autoFolders = turnedOn ? folders.filter((folder) => folder.kind === "auto") : [];
        publish(await refileMeetings(autoFolders.map((folder) => ({ folder, before: null }))));
      });
      if (patch.retention !== undefined) await expire();
    },
    async search(query) {
      const hits: MeetingSearchHit[] = [];
      for (const meeting of list()) {
        const quick = searchMeeting(meeting, [], query);
        const hit = quick ?? searchMeeting(meeting, await readTranscript(meeting.id), query);
        if (hit) hits.push(hit);
      }
      return hits;
    },
    expire,
    unfinished: () =>
      serial(async () => {
        const left = [...meetings.values()].filter((meeting) => meeting.status.kind !== "ready");
        return Promise.all(
          left.map(async (meeting) => ({ meeting, lastWriteAt: await newestWrite(meeting) })),
        );
      }),
    async settled() {
      let step: Promise<void>;
      do {
        step = queue;
        await step;
      } while (step !== queue);
    },
  };

  async function newestWrite(meeting: Meeting): Promise<number> {
    const folder = meetingDir(meeting.id);
    const names = await readdir(folder).catch(() => []);
    const times = await Promise.all(
      names.map((name) =>
        stat(NodePath.join(folder, name)).then(
          (info) => info.mtimeMs,
          () => 0,
        ),
      ),
    );
    return Math.max(meeting.createdAt, ...times);
  }
}

// A crash mid-append leaves a line with no newline; the next line must not join it.
async function tornTail(file: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    await handle.close();
  }
}

const lines = (entries: readonly TranscriptEntry[]) =>
  entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");

const cleanDraft = (draft: FolderDraft): FolderDraft =>
  draft.kind === "auto"
    ? {
        name: draft.name.trim(),
        kind: "auto",
        rule: { ...draft.rule, text: draft.rule.text.trim() },
      }
    : { name: draft.name.trim(), kind: "manual" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isText = (value: unknown): value is string => typeof value === "string";

function parseSpan(raw: unknown): Span | null {
  if (!isRecord(raw) || !isTime(raw.startedAt) || !isTime(raw.endedAt)) return null;
  return raw.endedAt >= raw.startedAt ? { startedAt: raw.startedAt, endedAt: raw.endedAt } : null;
}

function parseStatus(raw: unknown): MeetingStatus | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "starting":
      return raw.from === "new" || raw.from === "paused" || raw.from === "ready"
        ? { kind: "starting", from: raw.from }
        : null;
    case "recording":
      return isTime(raw.since) ? { kind: "recording", since: raw.since } : null;
    case "transcribing":
      return raw.step === "draining" || raw.step === "finalizing"
        ? { kind: "transcribing", step: raw.step }
        : null;
    // Progress is only for the run that reported it.
    case "summarizing":
      return { kind: "summarizing", progress: null };
    case "paused":
    case "finishing":
    case "confirmingShort":
    case "ready":
      return { kind: raw.kind };
    default:
      return null;
  }
}

function parseSummaryBody(raw: unknown): Summary | null {
  if (!isRecord(raw) || !isText(raw.markdown)) return null;
  if (!isTime(raw.coversUntilMs)) return null;
  return { markdown: raw.markdown, coversUntilMs: raw.coversUntilMs };
}

function parseSummary(raw: unknown): SummaryState | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "none") return { kind: "none" };
  if (raw.kind === "ready") {
    const summary = parseSummaryBody(raw.summary);
    return summary ? { kind: "ready", summary } : null;
  }
  if (raw.kind === "failed" && isText(raw.message)) {
    return { kind: "failed", message: raw.message, previous: parseSummaryBody(raw.previous) };
  }
  return null;
}

function parseMeeting(raw: unknown): Meeting | null {
  if (!isRecord(raw)) return null;
  const id = parseMeetingId(raw.id);
  const status = parseStatus(raw.status);
  const summary = parseSummary(raw.summary);
  if (!id || !status || !summary || !isTime(raw.createdAt) || !isText(raw.notes)) return null;
  const { finalPassFailed } = raw;
  if (
    finalPassFailed !== null &&
    finalPassFailed !== "speakerModels" &&
    finalPassFailed !== "other"
  )
    return null;
  if (!Number.isSafeInteger(raw.transcriptRevision)) return null;
  if (!Array.isArray(raw.spans) || !Array.isArray(raw.folderIds)) return null;
  const spans = raw.spans.map(parseSpan);
  if (spans.some((span) => span === null)) return null;
  if (raw.title !== null && !isText(raw.title)) return null;
  return {
    id,
    title: raw.title,
    createdAt: raw.createdAt,
    spans: spans as Span[],
    status,
    folderIds: raw.folderIds.flatMap((folderId) => parseFolderId(folderId) ?? []),
    notes: raw.notes,
    summary,
    speakers: Array.isArray(raw.speakers) ? raw.speakers.flatMap(parseSpeaker) : [],
    finalPassFailed,
    transcriptRevision: raw.transcriptRevision as number,
  };
}

function parseSpeaker(raw: unknown): Speaker[] {
  if (!isRecord(raw) || !isText(raw.id) || !isText(raw.label)) return [];
  const speaker = { id: raw.id as SpeakerId, label: raw.label };
  if (raw.name !== null && !isText(raw.name)) return [];
  return [{ ...speaker, name: raw.name }];
}

function parseFolders(raw: unknown): Folder[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): Folder[] => {
    if (!isRecord(item)) return [];
    const id = parseFolderId(item.id);
    if (!id || !isText(item.name) || !isTime(item.createdAt)) return [];
    const base = { id, name: item.name, createdAt: item.createdAt };
    if (item.kind === "manual") return [{ ...base, kind: "manual" }];
    const rule = isRecord(item.rule) ? item.rule : {};
    if (item.kind === "auto" && rule.kind === "titleContains" && isText(rule.text)) {
      return [{ ...base, kind: "auto", rule: { kind: "titleContains", text: rule.text } }];
    }
    return [];
  });
}

function parseLine(line: string): TranscriptEntry[] {
  if (line.trim() === "") return [];
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(raw)) return [];
  if (raw.kind === "marker") {
    const marker = markerKinds.find((kind) => kind === raw.marker);
    return marker && isTime(raw.atMs) ? [{ kind: "marker", marker, atMs: raw.atMs }] : [];
  }
  if (raw.kind !== "segment" || !isText(raw.id) || !isText(raw.text)) return [];
  if (!isTime(raw.startMs) || !isTime(raw.endMs)) return [];
  const base = {
    kind: "segment" as const,
    id: raw.id,
    startMs: raw.startMs,
    endMs: raw.endMs,
    text: raw.text,
  };
  if (raw.source === "mic") return [{ ...base, source: "mic" }];
  if (raw.source === "system") {
    const speakerId = isText(raw.speakerId) ? (raw.speakerId as SpeakerId) : null;
    return [{ ...base, source: "system", speakerId }];
  }
  return [];
}

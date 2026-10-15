import { readdir, readFile, rm } from "node:fs/promises";
import * as NodePath from "node:path";

import {
  historyRetentions,
  retentionMs,
  type HistoryEntry,
  type HistoryRetention,
  type HistoryState,
  type HistoryStatus,
  type Transcript,
} from "../shared/history.ts";
import { writeFileAtomic } from "./atomic-file.ts";
import type { Log } from "./diagnostics-scrub.ts";

export type History = {
  /** Adds the session's transcript, or replaces its text while the session is still on it. */
  remember(transcript: Transcript, at: number): void;
  /** Ends a pending entry. A session that produced no transcript has none, and nothing happens. */
  settle(id: string, inserted: boolean): void;
  entries(): readonly HistoryEntry[];
  state(): HistoryState;
  /** Resolves once the launch read of the file is in the list and the window is known. */
  loaded(): Promise<void>;
  /** Drops entries whose window ended. The timer runs late after sleep, so wake-ups call this. */
  expire(): void;
  /** Rejects, and keeps the entry, when the saved history could not be updated. */
  remove(id: string): Promise<void>;
  /** Rejects, and keeps the entries, when the saved history could not be deleted. */
  clear(): Promise<void>;
  /**
   * Writes the window with the entries, or deletes the file for memory, and keeps the old window
   * when that fails, so the published retention is what the file holds.
   */
  setRetention(next: HistoryRetention): Promise<void>;
  /**
   * Drops expired entries, then resolves once every disk operation has finished, including the
   * ones those operations queued, so the state afterwards says whether the list is on disk.
   */
  settled(): Promise<void>;
};

type SavedRetention = Exclude<HistoryRetention, "memory">;

/**
 * What the file is to this run. The file names the window: no file means memory. `loading` is
 * the launch read; nothing is written until it ends. `leftAlone` is a file this run could not
 * use, which it never overwrites or deletes on its own: the run keeps history in memory and says
 * saving failed, `retention` is only what the user chose since, and a clear or a switch to memory
 * removes the file.
 */
type Disk =
  | { kind: "loading" }
  | { kind: "memory" }
  | { kind: "ok"; retention: SavedRetention }
  | { kind: "writeFailed"; retention: SavedRetention }
  | { kind: "leftAlone"; retention: HistoryRetention };

const writable = (value: Disk): value is Extract<Disk, { kind: "ok" | "writeFailed" }> =>
  value.kind === "ok" || value.kind === "writeFailed";

type Envelope = { retention: SavedRetention; entries: HistoryEntry[] };

// setTimeout turns a longer delay into an immediate one; the timer re-arms when it fires early.
const MAX_TIMER_MS = 2 ** 31 - 1;

class LeftAlone extends Error {}

export function createHistory(options: {
  file: string;
  log: Log;
  onChange: (state: HistoryState) => void;
  now?: () => number;
}): History {
  const { file, log } = options;
  const now = options.now ?? Date.now;
  const logSaveFailure = (error: unknown) => log(`history: save failed (${String(error)})`);
  let entries: readonly HistoryEntry[] = [];
  // The list the file holds, by identity: every change makes a new list, so a sync writes until
  // they are the same one. Null when the file holds nothing of the list, or something older.
  let fileHolds: readonly HistoryEntry[] | null = null;
  let disk: Disk = { kind: "loading" };
  // A sweep could not remove a temp file, which may hold a transcript the user thinks is gone, so
  // the hub hears about it until a sweep succeeds.
  let tempsLeft = false;
  // Ids the user deleted this run, so a later transcript or refinement of the same session does
  // not bring the entry back.
  const tombstones = new Set<string>();
  // The ids each clear asked for but has not yet run covers. A load that finishes meanwhile adds
  // what it read, since the clear covers the file too.
  const pendingClears: Set<string>[] = [];
  let expiry: NodeJS.Timeout | null = null;
  // The hub hears nothing before the launch read: an early list would look complete.
  let ready = false;
  let published: { entries: readonly HistoryEntry[]; state: HistoryState } | null = null;
  let publishQueued = false;
  let syncQueued = false;
  let queue: Promise<void> = Promise.resolve();

  const retentionNow = (): HistoryRetention =>
    disk.kind === "loading" || disk.kind === "memory" ? "memory" : disk.retention;
  const saveFailed = () => disk.kind === "writeFailed" || disk.kind === "leftAlone" || tempsLeft;
  const state = (): HistoryState => ({
    entries: pruned(entries),
    retention: retentionNow(),
    saveFailed: saveFailed(),
  });

  function pruned(list: readonly HistoryEntry[], window = retentionNow()): readonly HistoryEntry[] {
    const ms = retentionMs[window];
    if (!Number.isFinite(ms)) return list;
    const cutoff = now() - ms;
    const oldest = list.at(-1);
    return oldest === undefined || oldest.at > cutoff
      ? list
      : list.filter((entry) => entry.at > cutoff);
  }

  // Both run after the caller's turn and the I/O already queued, so a session's insert command
  // reaches the helper before the hub gets the list or the file gets serialized.
  function publishSoon() {
    if (publishQueued || !ready) return;
    publishQueued = true;
    setImmediate(() => {
      publishQueued = false;
      const next = state();
      if (
        published &&
        published.entries === entries &&
        published.state.retention === next.retention &&
        published.state.saveFailed === next.saveFailed
      )
        return;
      published = { entries, state: next };
      options.onChange(next);
    });
  }

  function requestSync() {
    if (syncQueued) return;
    syncQueued = true;
    serial(async () => {
      syncQueued = false;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await sync();
    }).catch(() => {});
  }

  function scheduleExpiry() {
    if (expiry) clearTimeout(expiry);
    expiry = null;
    const ms = retentionMs[retentionNow()];
    const oldest = entries.at(-1);
    if (!Number.isFinite(ms) || oldest === undefined) return;
    expiry = setTimeout(expire, Math.min(MAX_TIMER_MS, Math.max(0, oldest.at + ms - now())));
    expiry.unref();
  }

  function expire() {
    const kept = pruned(entries);
    if (kept === entries) scheduleExpiry();
    else change(kept);
  }

  function change(next: readonly HistoryEntry[]) {
    entries = next;
    publishSoon();
    requestSync();
    scheduleExpiry();
  }

  function setDisk(next: Disk) {
    disk = next;
    publishSoon();
    scheduleExpiry();
  }

  function forget(ids: ReadonlySet<string>) {
    for (const id of ids) tombstones.add(id);
    const next = entries.filter((entry) => !ids.has(entry.id));
    if (next.length !== entries.length) change(next);
  }

  // Takes what a read found into the list. A clear asked for before the read covers it too.
  function merge(loaded: readonly HistoryEntry[]) {
    for (const doomed of pendingClears) for (const entry of loaded) doomed.add(entry.id);
    const known = new Set(entries.map((entry) => entry.id));
    const fresh = loaded.filter((entry) => !known.has(entry.id) && !tombstones.has(entry.id));
    if (fresh.length > 0) change([...entries, ...fresh].toSorted(newestFirst));
  }

  function serial(step: () => Promise<void>): Promise<void> {
    const run = queue.then(step);
    queue = run.catch(() => {});
    return run;
  }

  const write = (list: readonly HistoryEntry[], retention: SavedRetention) =>
    writeFileAtomic(file, `${JSON.stringify({ version: VERSION, retention, entries: list })}\n`, {
      mode: 0o600,
    });

  /**
   * Writes `list` as the file. When the entries did not move on during the write, the file holds
   * them: `list` is the entries themselves or their replacement, which becomes the entries. When
   * they did move on, the change that moved them queued a sync that writes the newer list.
   */
  async function persist(list: readonly HistoryEntry[], retention: SavedRetention) {
    const base = entries;
    await write(pruned(list, retention), retention);
    setDisk({ kind: "ok", retention });
    if (entries !== base) return;
    if (list !== base) change(list);
    fileHolds = entries;
  }

  async function sync() {
    if (writable(disk) && fileHolds !== entries) await save(disk.retention);
  }

  // A write whose failure is the run's state rather than a caller's error.
  async function save(retention: SavedRetention) {
    try {
      await persist(entries, retention);
    } catch (error) {
      setDisk({ kind: "writeFailed", retention });
      logSaveFailure(error);
    }
  }

  async function removeTemps() {
    const dir = NodePath.dirname(file);
    const prefix = `${NodePath.basename(file)}.`;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await Promise.all(
      names
        .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
        .map((name) => rm(NodePath.join(dir, name), { force: true })),
    );
    tempsLeft = false;
    publishSoon();
  }

  // Hygiene after a crash. It never gates a read or a clear of the list; a failure is reported.
  async function sweepTemps() {
    try {
      await removeTemps();
    } catch (error) {
      tempsLeft = true;
      publishSoon();
      log(`history: could not remove temp files (${String(error)})`);
    }
  }

  // Temps go first: a failure there leaves the file in place, so the history is never half gone.
  async function removeFile() {
    await removeTemps();
    await rm(file, { force: true });
  }

  /** The file's window and entries, null when there is no file, and LeftAlone for one to keep off. */
  async function load(): Promise<Envelope | null> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new LeftAlone(`could not read the saved history (${String(error)})`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LeftAlone("the saved history is not JSON");
    }
    return parseEnvelope(parsed);
  }

  const loading = serial(async () => {
    try {
      const found = await load();
      if (found === null) {
        setDisk({ kind: "memory" });
      } else {
        const { retention } = found;
        const kept = pruned(found.entries, retention);
        const dirty = entries.length > 0 || kept !== found.entries;
        merge(kept);
        if (dirty) {
          await save(retention);
        } else {
          setDisk({ kind: "ok", retention });
          fileHolds = entries;
        }
      }
    } catch (error) {
      if (!(error instanceof LeftAlone)) throw error;
      setDisk({ kind: "leftAlone", retention: "memory" });
      log(`history: ${error.message}, so this run keeps it in memory`);
    }
    await sweepTemps();
    ready = true;
    publishSoon();
  });

  return {
    remember({ id, raw, text, status }, at) {
      if (tombstones.has(id)) return;
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) {
        const after = entries.findIndex((entry) => entry.at <= at);
        const entry = { id, at, raw, text, status };
        change(after < 0 ? [...entries, entry] : entries.toSpliced(after, 0, entry));
        return;
      }
      const existing = entries[index]!;
      if (existing.status !== "pending") return;
      change(entries.with(index, { ...existing, raw, text, status }));
    },
    settle(id, inserted) {
      const index = entries.findIndex((entry) => entry.id === id && entry.status === "pending");
      if (index < 0) return;
      const status = inserted ? "inserted" : "notInserted";
      change(entries.with(index, { ...entries[index]!, status }));
    },
    entries: () => pruned(entries),
    state,
    loaded: () => loading,
    expire,
    remove: (id) =>
      serial(async () => {
        const next = entries.filter((entry) => entry.id !== id);
        if (next.length === entries.length) return;
        if (writable(disk)) await persist(next, disk.retention);
        forget(new Set([id]));
      }),
    clear() {
      const doomed = new Set(entries.map((entry) => entry.id));
      pendingClears.push(doomed);
      return serial(async () => {
        pendingClears.shift();
        const retention = retentionNow();
        if (retention === "memory") {
          // A file left alone is one the user asked to be rid of too.
          await rm(file, { force: true });
          await sweepTemps();
          setDisk({ kind: "memory" });
          forget(doomed);
          return;
        }
        await removeTemps();
        await persist(
          entries.filter((entry) => !doomed.has(entry.id)),
          retention,
        );
        forget(doomed);
      });
    },
    setRetention: (next) =>
      serial(async () => {
        if (next === "memory") {
          if (disk.kind === "memory") return;
          await removeFile();
          setDisk({ kind: "memory" });
          return;
        }
        if (disk.kind === "leftAlone") {
          setDisk({ kind: "leftAlone", retention: next });
          return;
        }
        if (disk.kind === "memory") {
          // A file that appeared since launch is read before anything is written over it. The
          // disk stays memory until the write lands, so a failure leaves nothing to undo.
          const found = await load();
          if (found) merge(pruned(found.entries, next));
          await persist(entries, next);
          await sweepTemps();
          return;
        }
        if (writable(disk) && disk.retention !== next) await persist(entries, next);
      }),
    async settled() {
      expire();
      let step: Promise<void>;
      do {
        step = queue;
        await step;
      } while (step !== queue);
    },
  };
}

const VERSION = 1;

const newestFirst = (a: HistoryEntry, b: HistoryEntry) => b.at - a.at;
const isText = (value: unknown): value is string => typeof value === "string";
const isStatus = (value: unknown): value is HistoryStatus =>
  value === "pending" || value === "inserted" || value === "notInserted";
const isSavedRetention = (value: unknown): value is SavedRetention =>
  value !== "memory" && historyRetentions.some((retention) => retention === value);
const statusAfterRestart = (status: HistoryStatus): HistoryStatus =>
  status === "pending" ? "notInserted" : status;

function parseEnvelope(raw: unknown): Envelope {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new LeftAlone("the saved history is not an object");
  }
  const { version, retention, entries } = raw as Record<string, unknown>;
  if (typeof version === "number" && version > VERSION) {
    throw new LeftAlone(`the saved history is from a newer Voice (version ${version})`);
  }
  if (version !== VERSION) throw new LeftAlone("the saved history has no version");
  if (!isSavedRetention(retention)) throw new LeftAlone("the saved history names no window");
  return { retention, entries: parseEntries(entries) };
}

function parseEntries(raw: unknown): HistoryEntry[] {
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const entries: HistoryEntry[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const { id, at, raw: said, text, status } = item as Record<string, unknown>;
    if (!isText(id) || id === "" || seen.has(id)) continue;
    if (typeof at !== "number" || Number.isNaN(new Date(at).getTime())) continue;
    if (!isText(said) || !isText(text) || !isStatus(status)) continue;
    seen.add(id);
    entries.push({
      id,
      at,
      raw: said,
      text,
      status: statusAfterRestart(status),
    });
  }
  return entries.toSorted(newestFirst);
}

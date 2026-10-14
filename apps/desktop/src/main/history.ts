import { readdir, readFile, rm } from "node:fs/promises";
import * as NodePath from "node:path";

import {
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
  /** Resolves once the launch read of the saved history is in the list; at once in memory mode. */
  loaded(): Promise<void>;
  /** Drops entries whose window ended. The timer runs late after sleep, so wake-ups call this. */
  expire(): void;
  /** Rejects, and keeps the entry, when the saved history could not be updated. */
  remove(id: string): Promise<void>;
  /** Rejects, and keeps the entries, when the saved history could not be deleted. */
  clear(): Promise<void>;
  /**
   * Saves under the new window, picks up or deletes the file when memory is one side of the
   * change, and keeps the old retention when that fails, so the caller records only what landed.
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
 * What the file is to this run. `written` is the revision it holds; a change bumps the revision,
 * and a sync writes again until they agree.
 */
type Disk =
  | { kind: "memory" }
  | { kind: "loading"; retention: SavedRetention }
  | { kind: "ok"; retention: SavedRetention }
  | { kind: "writeFailed"; retention: SavedRetention }
  | { kind: "leftAlone"; retention: SavedRetention };

const writable = (value: Disk): value is Extract<Disk, { kind: "ok" | "writeFailed" }> =>
  value.kind === "ok" || value.kind === "writeFailed";

/** A clear asked for but not yet run: the ids it covers, and entries a load handed it meanwhile. */
type PendingClear = { doomed: Set<string>; held: HistoryEntry[] };
// setTimeout turns a longer delay into an immediate one; the timer re-arms when it fires early.
const MAX_TIMER_MS = 2 ** 31 - 1;

class LeftAlone extends Error {}

export function createHistory(options: {
  file: string;
  retention: HistoryRetention;
  log: Log;
  onChange: (state: HistoryState) => void;
  now?: () => number;
}): History {
  const { file, log } = options;
  const now = options.now ?? Date.now;
  const logSaveFailure = (error: unknown) => log(`history: save failed (${String(error)})`);
  let entries: readonly HistoryEntry[] = [];
  let revision = 0;
  let written: number | null = null;
  let disk: Disk = { kind: "memory" };
  // Ids the user deleted this run, so a later transcript or refinement of the same session does
  // not bring the entry back.
  const tombstones = new Set<string>();
  // Oldest first. A load that finishes while one is pending hands it the entries it read instead
  // of showing them, since the clear covers the file too.
  const pendingClears: PendingClear[] = [];
  let expiry: NodeJS.Timeout | null = null;
  let publishQueued = false;
  let syncQueued = false;
  let diskQueue: Promise<void> = Promise.resolve();
  let loading: Promise<void> = Promise.resolve();

  const retentionNow = (): HistoryRetention => (disk.kind === "memory" ? "memory" : disk.retention);
  const saveFailed = () => disk.kind === "writeFailed" || disk.kind === "leftAlone";
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
    if (publishQueued) return;
    publishQueued = true;
    setImmediate(() => {
      publishQueued = false;
      options.onChange(state());
    });
  }

  function requestSync() {
    if (syncQueued || disk.kind === "memory") return;
    syncQueued = true;
    onDisk(async () => {
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
    revision += 1;
    publishSoon();
    requestSync();
    scheduleExpiry();
  }

  function setDisk(next: Disk) {
    const before = state();
    disk = next;
    if (saveFailed() !== before.saveFailed || retentionNow() !== before.retention) publishSoon();
    scheduleExpiry();
  }

  function forget(ids: ReadonlySet<string>) {
    for (const id of ids) tombstones.add(id);
    const next = entries.filter((entry) => !ids.has(entry.id));
    if (next.length !== entries.length) change(next);
  }

  function merge(loaded: readonly HistoryEntry[]) {
    const known = new Set(entries.map((entry) => entry.id));
    const fresh = loaded.filter((entry) => !known.has(entry.id));
    if (fresh.length > 0) change([...entries, ...fresh].toSorted(newestFirst));
  }

  // Entries a load handed to a clear that then failed. The file still holds them, so they show
  // again, unless another clear is waiting for them.
  function restore(held: HistoryEntry[]) {
    const next = pendingClears[0];
    if (next) {
      next.held.push(...held);
      return;
    }
    const fileOnly = entries.length === 0;
    merge(held);
    // Nothing arrived since the read, so the file holds exactly these and needs no write.
    if (fileOnly) written = revision;
  }

  function onDisk(step: () => Promise<void>): Promise<void> {
    const run = diskQueue.then(step);
    diskQueue = run.catch(() => {});
    return run;
  }

  const write = (list: readonly HistoryEntry[]) =>
    writeFileAtomic(file, `${JSON.stringify({ version: VERSION, entries: list })}\n`, {
      mode: 0o600,
    });

  /**
   * Writes `list` as the file. When the entries did not move on during the write, the file holds
   * them: `list` is the entries themselves or their replacement, which becomes the entries. When
   * they did move on, the change that moved them queued a sync that writes the newer list.
   */
  async function persist(list: readonly HistoryEntry[], retention: SavedRetention) {
    const base = entries;
    await write(pruned(list, retention));
    setDisk({ kind: "ok", retention });
    if (entries !== base) return;
    if (list !== base) change(list);
    written = revision;
  }

  async function sync() {
    if (!writable(disk) || written === revision) return;
    const { retention } = disk;
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
  }

  // Temps go first: a failure there leaves the file in place, so the history is never half gone.
  async function removeFile() {
    await removeTemps();
    await rm(file, { force: true });
  }

  async function load(): Promise<HistoryEntry[]> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new LeftAlone(`could not read the saved history (${String(error)})`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      log("history: the saved history is not JSON, so it starts over");
      return [];
    }
    const version =
      typeof parsed === "object" && parsed !== null && "version" in parsed ? parsed.version : null;
    if (typeof version === "number" && version > VERSION) {
      throw new LeftAlone(`the saved history is from a newer Voice (version ${version})`);
    }
    return parseHistory(parsed);
  }

  // Reads the file into the list and writes the list back when they differ.
  async function adopt(retention: SavedRetention) {
    await removeTemps();
    const loaded = await load();
    const dirty = entries.length > 0 || pruned(loaded, retention) !== loaded;
    const pending = pendingClears[0];
    if (pending) {
      // The clear deletes the file, or hands these back if it fails; a write now would only churn.
      pending.held.push(...loaded);
      setDisk({ kind: "ok", retention });
      written = null;
      return;
    }
    merge(loaded);
    if (dirty) {
      await persist(entries, retention);
      return;
    }
    setDisk({ kind: "ok", retention });
    written = revision;
  }

  if (options.retention === "memory") {
    onDisk(removeTemps).catch((error: unknown) =>
      log(`history: could not remove temp files (${String(error)})`),
    );
  } else {
    const retention = options.retention;
    disk = { kind: "loading", retention };
    loading = onDisk(async () => {
      try {
        await adopt(retention);
      } catch (error) {
        if (error instanceof LeftAlone) {
          setDisk({ kind: "leftAlone", retention });
          log(`history: ${error.message}, so this run keeps it in memory`);
        } else {
          setDisk({ kind: "writeFailed", retention });
          logSaveFailure(error);
        }
      }
    });
  }

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
      onDisk(async () => {
        const next = entries.filter((entry) => entry.id !== id);
        if (next.length === entries.length) return;
        if (writable(disk)) await persist(next, disk.retention);
        forget(new Set([id]));
      }),
    clear() {
      const pending: PendingClear = { doomed: new Set(entries.map((entry) => entry.id)), held: [] };
      pendingClears.push(pending);
      return onDisk(async () => {
        pendingClears.shift();
        try {
          await removeFile();
        } catch (error) {
          restore(pending.held);
          throw error;
        }
        forget(pending.doomed);
        if (disk.kind === "memory") return;
        // The file is gone, so what the user added since the clear has to be written again.
        written = entries.length === 0 ? revision : null;
        setDisk({ kind: "ok", retention: disk.retention });
        requestSync();
      });
    },
    setRetention: (next) =>
      onDisk(async () => {
        if (next === retentionNow()) return;
        if (next === "memory") {
          await removeFile();
          setDisk({ kind: "memory" });
          return;
        }
        if (disk.kind === "memory") {
          setDisk({ kind: "loading", retention: next });
          try {
            await adopt(next);
          } catch (error) {
            setDisk({ kind: "memory" });
            throw error;
          }
          return;
        }
        if (disk.kind === "leftAlone") {
          setDisk({ kind: "leftAlone", retention: next });
          return;
        }
        await persist(entries, next);
      }),
    async settled() {
      expire();
      let queue: Promise<void>;
      do {
        queue = diskQueue;
        await queue;
      } while (queue !== diskQueue);
    },
  };
}

const VERSION = 1;

const newestFirst = (a: HistoryEntry, b: HistoryEntry) => b.at - a.at;
const isText = (value: unknown): value is string => typeof value === "string";
const isStatus = (value: unknown): value is HistoryStatus =>
  value === "pending" || value === "inserted" || value === "notInserted";
const statusAfterRestart = (status: HistoryStatus): HistoryStatus =>
  status === "pending" ? "notInserted" : status;

export function parseHistory(raw: unknown): HistoryEntry[] {
  const list: unknown[] =
    typeof raw === "object" && raw !== null && "entries" in raw && Array.isArray(raw.entries)
      ? raw.entries
      : [];
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

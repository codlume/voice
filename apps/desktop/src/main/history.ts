import { readdir, readFile, rm } from "node:fs/promises";
import * as NodePath from "node:path";

import {
  historyRetentions,
  insertEntry,
  retentionMs,
  type HistoryChange,
  type HistoryEntry,
  type HistoryRetention,
  type HistoryState,
  type HistoryStatus,
  type Transcript,
} from "../shared/history.ts";
import { writeFileAtomic } from "./atomic-file.ts";
import type { Log } from "./diagnostics-scrub.ts";

export type History = {
  remember(transcript: Transcript, at: number): void;
  settle(id: string, inserted: boolean): void;
  entries(): readonly HistoryEntry[];
  state(): HistoryState;
  loaded(): Promise<void>;
  /** The timer runs late after sleep, so wake-ups call this. */
  expire(): void;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  setRetention(next: HistoryRetention): Promise<void>;
  settled(): Promise<void>;
};

type SavedRetention = Exclude<HistoryRetention, "memory">;

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
  onChange: (change: HistoryChange) => void;
  now?: () => number;
}): History {
  const { file, log } = options;
  const now = options.now ?? Date.now;
  const logSaveFailure = (error: unknown) => log(`history: save failed (${String(error)})`);
  let entries: readonly HistoryEntry[] = [];
  let fileHolds: readonly HistoryEntry[] | null = null;
  let disk: Disk = { kind: "loading" };
  let tempsLeft = false;
  const tombstones = new Set<string>();
  const pendingClears: Set<string>[] = [];
  let expiry: NodeJS.Timeout | null = null;
  let ready = false;
  let published: Omit<HistoryState, "entries"> | null = null;
  let hubHolds: readonly HistoryEntry[] = [];
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

  function publishSoon() {
    if (publishQueued || !ready) return;
    publishQueued = true;
    setImmediate(() => {
      publishQueued = false;
      const { entries: list, ...next } = state();
      const message = changeSince(list, next);
      if (message === null) return;
      published = next;
      options.onChange(message);
    });
  }

  function changeSince(
    list: readonly HistoryEntry[],
    next: Omit<HistoryState, "entries">,
  ): HistoryChange | null {
    const held = hubHolds;
    let head = held === list ? list.length : 0;
    while (head < list.length && head < held.length && list[head] === held[head]) head += 1;
    let tail = 0;
    while (
      tail < list.length - head &&
      tail < held.length - head &&
      list[list.length - 1 - tail] === held[held.length - 1 - tail]
    ) {
      tail += 1;
    }
    const before = new Map(held.slice(head, held.length - tail).map((entry) => [entry.id, entry]));
    const after = list.slice(head, list.length - tail);
    const upsert = after.filter((entry) => before.get(entry.id) !== entry);
    const stayed = new Set(after.map((entry) => entry.id));
    const remove = [...before.keys()].filter((id) => !stayed.has(id));
    hubHolds = list;
    if (published === null || remove.length > list.length) {
      return { kind: "all", state: { entries: list, ...next } };
    }
    const same = published.retention === next.retention && published.saveFailed === next.saveFailed;
    if (same && upsert.length === 0 && remove.length === 0) return null;
    return { kind: "patch", upsert, remove, ...next };
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

  async function sweepTemps() {
    try {
      await removeTemps();
    } catch (error) {
      tempsLeft = true;
      publishSoon();
      log(`history: could not remove temp files (${String(error)})`);
    }
  }

  async function removeFile() {
    await removeTemps();
    await rm(file, { force: true });
  }

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

  function leaveAlone(error: LeftAlone, retention: HistoryRetention) {
    setDisk({ kind: "leftAlone", retention });
    log(`history: ${error.message}, so this run keeps it in memory`);
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
      leaveAlone(error, "memory");
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
        change(insertEntry(entries, { id, at, raw, text, status }));
        return;
      }
      const existing = entries[index]!;
      if (existing.status !== "pending") return;
      entries = entries.with(index, { ...existing, raw, text, status });
      publishSoon();
    },
    settle(id, inserted) {
      const index = entries.findIndex((entry) => entry.id === id && entry.status === "pending");
      if (index < 0) return;
      const status: HistoryStatus = inserted ? "inserted" : "notInserted";
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
          let found: Envelope | null;
          try {
            found = await load();
          } catch (error) {
            if (!(error instanceof LeftAlone)) throw error;
            leaveAlone(error, next);
            return;
          }
          if (found) merge(pruned(found.entries, next));
          await persist(entries, next);
          await sweepTemps();
          return;
        }
        if (writable(disk) && disk.retention !== next) await persist(entries, next);
      }),
    async settled() {
      expire();
      requestSync();
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
  if (version !== VERSION) throw new LeftAlone("the saved history has no version this Voice knows");
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

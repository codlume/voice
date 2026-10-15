import { execFileSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { HistoryEntry, HistoryRetention, HistoryState } from "../shared/history.ts";
import { createHistory } from "./history.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = new Date(2026, 9, 14, 12, 0).getTime();
// Root ignores file modes, so the permission-failure tests would pass without proving anything.
const asRoot = process.getuid?.() === 0;

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(NodePath.join(tmpdir(), "voice-history-"));
  file = NodePath.join(dir, "history.json");
});

afterEach(async () => {
  vi.useRealTimers();
  await chmod(dir, 0o700);
  await rm(dir, { recursive: true, force: true });
});

const envelope = (retention: HistoryRetention, entries: readonly unknown[]) =>
  JSON.stringify({ version: 1, retention, entries });

// `retention` plays an earlier run that chose the window: the store reads it from the file.
function harness(retention: HistoryRetention = "memory", options: { file?: string } = {}) {
  const path = options.file ?? file;
  if (retention !== "memory" && !existsSync(path)) writeFileSync(path, envelope(retention, []));
  const published: HistoryState[] = [];
  const logs: string[] = [];
  const state = { now: START };
  const history = createHistory({
    file: path,
    log: (message) => logs.push(message),
    onChange: (entries) => published.push(entries),
    now: () => state.now,
  });
  return { history, published, logs, state };
}

const settledTick = () => new Promise<void>((resolve) => setImmediate(resolve));
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const saved = async () =>
  JSON.parse(await readFile(file, "utf8")) as { retention: string; entries: HistoryEntry[] };
const ids = (entries: readonly HistoryEntry[]) => entries.map((entry) => entry.id);
const savedEntry = (id: string, at: number) => ({ id, at, raw: id, text: id, status: "inserted" });
const tempFiles = async () =>
  (await readdir(dir)).filter((name) => name.startsWith("history.json.") && name.endsWith(".tmp"));
const blockWrites = async () => {
  await rm(file, { force: true });
  await mkdir(file);
};
const unblockWrites = () => rm(file, { recursive: true });

describe("history in memory", () => {
  test("keeps one entry per session, newest first, and cleanup replaces its text in place", () => {
    const { history } = harness();
    history.remember({ id: "a", raw: "first", text: "first", status: "pending" }, 1000);
    history.settle("a", true);
    history.remember({ id: "b", raw: "um second", text: "um second", status: "pending" }, 2000);
    history.remember({ id: "b", raw: "um second", text: "Second.", status: "pending" }, 2500);
    history.settle("b", false);

    expect(history.entries()).toEqual([
      { id: "b", at: 2000, raw: "um second", text: "Second.", status: "notInserted" },
      { id: "a", at: 1000, raw: "first", text: "first", status: "inserted" },
    ]);
  });

  test("settling a session that left no transcript, or one already settled, changes nothing", async () => {
    const { history, published } = harness();
    history.settle("none", true);
    history.remember({ id: "late", raw: "late", text: "late", status: "notInserted" }, 1000);
    await settledTick();
    published.length = 0;
    history.settle("late", true);
    await settledTick();

    expect(history.entries()).toEqual([
      { id: "late", at: 1000, raw: "late", text: "late", status: "notInserted" },
    ]);
    expect(published).toEqual([]);
  });

  test("a late or duplicate transcript never moves a settled entry backwards", () => {
    const { history } = harness();
    history.remember({ id: "a", raw: "um hi", text: "um hi", status: "pending" }, 1000);
    history.remember({ id: "a", raw: "um hi", text: "Hi.", status: "pending" }, 1500);
    history.settle("a", true);
    history.remember({ id: "a", raw: "um hi", text: "um hi", status: "notInserted" }, 2000);

    expect(history.entries()).toEqual([
      { id: "a", at: 1000, raw: "um hi", text: "Hi.", status: "inserted" },
    ]);
  });

  test("tells the hub after the caller's turn, once for changes made together", async () => {
    const { history, published } = harness();
    await history.settled();
    await settledTick();
    published.length = 0;
    history.remember({ id: "a", raw: "hi", text: "hi", status: "pending" }, 1000);
    history.settle("a", true);
    expect(published).toEqual([]);
    await settledTick();
    expect(published).toEqual([
      {
        entries: [{ id: "a", at: 1000, raw: "hi", text: "hi", status: "inserted" }],
        retention: "memory",
        saveFailed: false,
      },
    ]);
  });

  test("deletes one entry or all of them", async () => {
    const { history, published } = harness();
    history.remember({ id: "a", raw: "a", text: "a", status: "pending" }, 1000);
    history.remember({ id: "b", raw: "b", text: "b", status: "pending" }, 2000);
    await history.remove("a");
    expect(ids(history.entries())).toEqual(["b"]);
    await history.clear();
    expect(history.entries()).toEqual([]);
    await settledTick();
    expect(published.at(-1)).toEqual({ entries: [], retention: "memory", saveFailed: false });
  });

  test("a deleted session stays deleted when its cleanup lands, and the next session is kept", async () => {
    const { history } = harness();
    history.remember({ id: "a", raw: "um raw", text: "um raw", status: "pending" }, 1000);
    await history.remove("a");
    history.remember({ id: "a", raw: "um raw", text: "Cleaned.", status: "pending" }, 1500);
    history.settle("a", true);
    expect(history.entries()).toEqual([]);

    history.remember({ id: "b", raw: "b", text: "b", status: "pending" }, 2000);
    expect(ids(history.entries())).toEqual(["b"]);
  });

  test("a cleared session stays cleared when its cleanup lands", async () => {
    const { history } = harness();
    history.remember({ id: "a", raw: "um raw", text: "um raw", status: "pending" }, 1000);
    await history.clear();
    history.remember({ id: "a", raw: "um raw", text: "Cleaned.", status: "pending" }, 1500);
    expect(history.entries()).toEqual([]);
  });

  test("a deleted session stays deleted after it settles and a late transcript arrives", async () => {
    const { history } = harness();
    history.remember({ id: "x", raw: "r", text: "r", status: "pending" }, 1000);
    await history.remove("x");
    history.remember({ id: "x", raw: "r", text: "R.", status: "pending" }, 1500);
    history.settle("x", true);
    history.remember({ id: "x", raw: "r", text: "r", status: "notInserted" }, 2000);
    expect(history.entries()).toEqual([]);
  });

  test("tells the hub it keeps the history in memory", async () => {
    const { history, published } = harness("memory");
    history.remember({ id: "a", raw: "a", text: "a", status: "notInserted" }, START);
    await history.settled();
    await settledTick();
    expect(published.at(-1)).toMatchObject({ retention: "memory", saveFailed: false });
    expect(history.state().retention).toBe("memory");
  });

  test("launch removes temp files a crash left behind, and writes no file", async () => {
    await writeFile(NodePath.join(dir, "history.json.12345.tmp"), "{}");
    const { history } = harness("memory");
    await history.settled();
    expect(await tempFiles()).toEqual([]);
    expect(await exists(file)).toBe(false);
  });

  test.skipIf(asRoot)(
    "a launch that cannot remove a temp file says so until a sweep removes it",
    async () => {
      const stale = NodePath.join(dir, "history.json.12345.tmp");
      await writeFile(stale, "{}");
      await chmod(dir, 0o300);
      const { history, published, logs } = harness("memory");
      await history.settled();
      await settledTick();
      expect(history.state()).toMatchObject({ retention: "memory", saveFailed: true });
      expect(published.at(-1)).toMatchObject({ retention: "memory", saveFailed: true });
      expect(logs).toEqual([expect.stringMatching(/^history: could not remove temp files/)]);

      await chmod(dir, 0o700);
      await history.clear();
      await settledTick();
      expect(await tempFiles()).toEqual([]);
      expect(history.state().saveFailed).toBe(false);
      expect(published.at(-1)?.saveFailed).toBe(false);
    },
  );

  test.skipIf(asRoot)(
    "a clear that cannot list the folder still clears the list, and says temp files stayed",
    async () => {
      const { history, logs } = harness("memory");
      history.remember({ id: "a", raw: "a", text: "a", status: "notInserted" }, START);
      await history.settled();
      await chmod(dir, 0o300);
      await history.clear();
      await chmod(dir, 0o700);
      expect(history.entries()).toEqual([]);
      expect(history.state().saveFailed).toBe(true);
      expect(logs).toEqual([expect.stringMatching(/^history: could not remove temp files/)]);
    },
  );

  test("writes nothing to disk", async () => {
    const { history } = harness("memory");
    history.remember({ id: "a", raw: "secret", text: "Secret.", status: "pending" }, START);
    history.settle("a", true);
    await history.settled();
    expect(await exists(file)).toBe(false);
    expect(ids(history.entries())).toEqual(["a"]);
  });

  test("has no timer to wake up for", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { history } = harness("memory");
    history.remember({ id: "a", raw: "a", text: "a", status: "notInserted" }, START);
    await history.settled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("saved history", () => {
  test("the file names the window, so a restart keeps it and brings back the entries, with one a quit cut short not inserted", async () => {
    const first = harness("month");
    first.history.remember({ id: "a", raw: "um hi", text: "Hi.", status: "pending" }, START);
    first.history.settle("a", true);
    first.history.remember({ id: "b", raw: "cut", text: "cut", status: "pending" }, START + 1);
    await first.history.settled();

    const second = harness();
    await second.history.settled();
    expect(second.history.state()).toMatchObject({ retention: "month", saveFailed: false });
    expect(second.history.entries()).toEqual([
      { id: "b", at: START + 1, raw: "cut", text: "cut", status: "notInserted" },
      { id: "a", at: START, raw: "um hi", text: "Hi.", status: "inserted" },
    ]);
  });

  test("the file is readable by this user only", async () => {
    const { history } = harness("month");
    history.remember({ id: "a", raw: "a", text: "a", status: "notInserted" }, START);
    await history.settled();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("a switch between windows is one write of the window with the entries", async () => {
    const { history } = harness("month");
    history.remember({ id: "a", raw: "a", text: "a", status: "notInserted" }, START);
    await history.settled();
    await history.setRetention("day");
    expect(await saved()).toEqual({
      version: 1,
      retention: "day",
      entries: [{ id: "a", at: START, raw: "a", text: "a", status: "notInserted" }],
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test.each([
    ["no window", JSON.stringify({ version: 1, entries: [] })],
    ["a window this Voice does not know", envelope("week" as HistoryRetention, [])],
    ["a newer Voice's version", JSON.stringify({ version: 2, retention: "day", entries: [] })],
    ["no JSON", "{ not json"],
    ["no object", "[]"],
  ])("a file with %s is left alone, and this run keeps history in memory", async (_, contents) => {
    await writeFile(file, contents);
    const { history, published, logs } = harness();
    history.remember({ id: "a", raw: "a", text: "a", status: "pending" }, START);
    await history.settled();
    await settledTick();
    expect(await readFile(file, "utf8")).toBe(contents);
    expect(await tempFiles()).toEqual([]);
    expect(ids(history.entries())).toEqual(["a"]);
    expect(history.state()).toMatchObject({ retention: "memory", saveFailed: true });
    expect(published.at(-1)).toMatchObject({ retention: "memory", saveFailed: true });
    expect(logs).toEqual([expect.stringMatching(/so this run keeps it in memory$/)]);
  });

  test.skipIf(asRoot)("a file that cannot be read is left alone", async () => {
    const contents = envelope("month", [savedEntry("old", START - HOUR)]);
    await writeFile(file, contents, { mode: 0o000 });
    const { history } = harness();
    history.remember({ id: "a", raw: "a", text: "a", status: "pending" }, START);
    await history.settled();
    expect(history.state()).toMatchObject({ retention: "memory", saveFailed: true });
    await chmod(file, 0o600);
    expect(await readFile(file, "utf8")).toBe(contents);
  });

  test("a window chosen while the file is left alone is only a label until a switch to memory deletes the file", async () => {
    const newer = JSON.stringify({ version: 2, retention: "day", entries: [] });
    await writeFile(file, newer);
    const { history } = harness();
    await history.settled();

    await history.setRetention("month");
    history.remember({ id: "a", raw: "a", text: "a", status: "pending" }, START);
    await history.settled();
    expect(history.state()).toMatchObject({ retention: "month", saveFailed: true });
    expect(await readFile(file, "utf8")).toBe(newer);

    await history.setRetention("memory");
    expect(await exists(file)).toBe(false);
    expect(history.state()).toMatchObject({ retention: "memory", saveFailed: false });
    expect(ids(history.entries())).toEqual(["a"]);
  });

  test("prunes entries older than the window when it loads", async () => {
    await writeFile(
      file,
      envelope("month", [
        savedEntry("old", START - 31 * DAY),
        savedEntry("recent", START - 29 * DAY),
      ]),
    );
    const { history } = harness();
    await history.settled();
    expect(ids(history.entries())).toEqual(["recent"]);
  });

  test("prunes on every write, from the file and from the list", async () => {
    const { history, state } = harness("day");
    history.remember({ id: "a", raw: "a", text: "a", status: "notInserted" }, START);
    await history.settled();
    state.now = START + 25 * HOUR;
    history.remember({ id: "b", raw: "b", text: "b", status: "pending" }, state.now);
    await history.settled();

    expect(ids((await saved()).entries)).toEqual(["b"]);
    expect(ids(history.entries())).toEqual(["b"]);
  });

  test("an entry leaves the list and the file when its window ends, with nothing else going on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { history, state, published } = harness("day");
    history.remember({ id: "a", raw: "a", text: "a", status: "notInserted" }, START);
    state.now = START + HOUR;
    history.remember({ id: "b", raw: "b", text: "b", status: "notInserted" }, state.now);
    await history.settled();
    expect(vi.getTimerCount()).toBe(1);

    state.now = START + DAY;
    vi.advanceTimersByTime(DAY - HOUR);
    await history.settled();
    expect(ids(history.entries())).toEqual(["b"]);
    expect(ids((await saved()).entries)).toEqual(["b"]);
    await settledTick();
    expect(ids(published.at(-1)?.entries ?? [])).toEqual(["b"]);
    expect(vi.getTimerCount()).toBe(1);

    state.now = START + DAY + HOUR;
    vi.advanceTimersByTime(HOUR);
    await history.settled();
    expect(history.entries()).toEqual([]);
    expect((await saved()).entries).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("forever keeps no timer, and a change to a window starts one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { history } = harness("forever");
    history.remember({ id: "a", raw: "a", text: "a", status: "notInserted" }, START);
    await history.settled();
    expect(vi.getTimerCount()).toBe(0);
    await history.setRetention("month");
    expect(vi.getTimerCount()).toBe(1);
    await history.setRetention("forever");
    expect(vi.getTimerCount()).toBe(0);
  });

  test("an expired entry never shows, even before the timer runs, and quitting drops it from the file", async () => {
    const { history, state } = harness("day");
    history.remember({ id: "a", raw: "a", text: "a", status: "notInserted" }, START);
    await history.settled();
    state.now = START + 25 * HOUR;
    expect(history.state().entries).toEqual([]);
    expect(history.entries()).toEqual([]);
    await history.settled();
    expect((await saved()).entries).toEqual([]);
  });

  test("switching to memory deletes the file at once and keeps the list", async () => {
    const { history } = harness("forever");
    history.remember({ id: "a", raw: "a", text: "a", status: "pending" }, START);
    await history.settled();
    expect(await exists(file)).toBe(true);

    await history.setRetention("memory");
    expect(await exists(file)).toBe(false);
    expect(ids(history.entries())).toEqual(["a"]);

    history.settle("a", true);
    await history.settled();
    expect(await exists(file)).toBe(false);
  });

  test("switching from memory saves what this run already has under the new window", async () => {
    const { history } = harness("memory");
    history.remember({ id: "a", raw: "a", text: "a", status: "pending" }, START);
    await history.setRetention("month");
    expect(await saved()).toMatchObject({ retention: "month" });
    expect(ids((await saved()).entries)).toEqual(["a"]);
  });

  test("switching from memory picks up a file that appeared since launch instead of overwriting it", async () => {
    const { history } = harness("memory");
    await history.settled();
    await writeFile(file, envelope("day", [savedEntry("old", START - HOUR)]));
    history.remember({ id: "new", raw: "new", text: "new", status: "notInserted" }, START);
    await history.setRetention("month");
    expect(ids(history.entries())).toEqual(["new", "old"]);
    expect(ids((await saved()).entries)).toEqual(["new", "old"]);
    expect((await saved()).retention).toBe("month");
  });

  test.skipIf(asRoot)(
    "a switch from memory removes temp files a launch could not, so saved stops meaning failed",
    async () => {
      const stale = NodePath.join(dir, "history.json.12345.tmp");
      await writeFile(stale, "{}");
      await chmod(dir, 0o300);
      const { history } = harness("memory");
      await history.settled();
      expect(history.state().saveFailed).toBe(true);

      await chmod(dir, 0o700);
      await history.setRetention("month");
      expect(await tempFiles()).toEqual([]);
      expect(history.state()).toMatchObject({ retention: "month", saveFailed: false });
    },
  );

  test("delete and clear reach the file, and a clear keeps the window", async () => {
    const { history } = harness("month");
    history.remember({ id: "a", raw: "a", text: "a", status: "notInserted" }, START);
    history.remember({ id: "b", raw: "b", text: "b", status: "notInserted" }, START + 1);
    await history.remove("b");
    expect(ids((await saved()).entries)).toEqual(["a"]);
    await history.clear();
    expect(await saved()).toEqual({ version: 1, retention: "month", entries: [] });

    const relaunched = harness();
    await relaunched.history.settled();
    expect(relaunched.history.state()).toMatchObject({ retention: "month", saveFailed: false });
  });

  test("a transcript added right after a clear is saved, and the file holds only it", async () => {
    const { history } = harness("month");
    history.remember({ id: "before", raw: "before", text: "before", status: "notInserted" }, START);
    const cleared = history.clear();
    history.remember(
      { id: "after", raw: "after", text: "after", status: "notInserted" },
      START + 1,
    );
    await cleared;
    await history.settled();
    expect(ids(history.entries())).toEqual(["after"]);
    expect(ids((await saved()).entries)).toEqual(["after"]);
    expect(history.state().saveFailed).toBe(false);
  });

  test("tells the hub which window it saves under, and the restart guard can trust it", async () => {
    const { history, published } = harness("month");
    history.remember({ id: "a", raw: "a", text: "a", status: "notInserted" }, START);
    await history.settled();
    await settledTick();
    expect(published.at(-1)).toMatchObject({ retention: "month", saveFailed: false });
    await history.setRetention("day");
    await settledTick();
    expect(published.at(-1)).toMatchObject({ retention: "day", saveFailed: false });
    expect(history.state().retention).toBe("day");
    expect((await saved()).retention).toBe("day");
  });

  test("tells the hub nothing until the file is read, then the complete state once", async () => {
    execFileSync("mkfifo", [file]);
    const { history, published } = harness();
    history.remember({ id: "a", raw: "a", text: "a", status: "pending" }, START);
    await settledTick();
    await settledTick();
    expect(published).toEqual([]);

    await writeFile(file, envelope("forever", [savedEntry("old", START - HOUR)]));
    await history.loaded();
    await settledTick();
    expect(published.map((state) => [ids(state.entries), state.retention])).toEqual([
      [["a", "old"], "forever"],
    ]);
  });

  test("the first state the hub asks for already holds the saved entries", async () => {
    await writeFile(file, envelope("month", [savedEntry("old", START - HOUR)]));
    const { history } = harness();
    expect(history.state().entries).toEqual([]);
    await history.loaded();
    expect(ids(history.state().entries)).toEqual(["old"]);
  });

  test("settled covers a save that a clear queued while it was draining", async () => {
    const { history } = harness("month");
    await history.settled();
    history.remember({ id: "before", raw: "before", text: "before", status: "notInserted" }, START);
    const clearing = history.clear();
    history.remember(
      { id: "after", raw: "after", text: "after", status: "notInserted" },
      START + 1,
    );
    await history.settled();
    expect(ids((await saved()).entries)).toEqual(["after"]);
    expect(history.state().saveFailed).toBe(false);
    await clearing;
  });

  test.skipIf(asRoot)(
    "a clear that fails while the saved history is loading keeps what the file holds",
    async () => {
      await writeFile(file, envelope("month", [savedEntry("saved", START - HOUR)]));
      await chmod(dir, 0o500);
      const { history } = harness();
      await expect(history.clear()).rejects.toThrow();
      await history.settled();
      expect(ids(history.entries())).toEqual(["saved"]);
      expect(history.state().saveFailed).toBe(false);

      await chmod(dir, 0o700);
      expect(ids((await saved()).entries)).toEqual(["saved"]);
      await history.clear();
      expect(history.entries()).toEqual([]);
      expect((await saved()).entries).toEqual([]);
    },
  );

  test("a clear that cannot remove a temp file deletes nothing and keeps the rows", async () => {
    const { history } = harness("month");
    history.remember({ id: "a", raw: "a", text: "a", status: "notInserted" }, START);
    await history.settled();
    const blocking = NodePath.join(dir, "history.json.1.tmp");
    await mkdir(blocking);
    await expect(history.clear()).rejects.toThrow();
    expect(ids((await saved()).entries)).toEqual(["a"]);
    expect(ids(history.entries())).toEqual(["a"]);
    expect(history.state().saveFailed).toBe(false);

    await rm(blocking, { recursive: true });
    await history.clear();
    expect(history.entries()).toEqual([]);
    expect((await saved()).entries).toEqual([]);
  });

  test.skipIf(asRoot)(
    "a switch to memory that cannot list the folder deletes nothing",
    async () => {
      const stale = NodePath.join(dir, "history.json.12345.tmp");
      const { history } = harness("month");
      history.remember({ id: "a", raw: "a", text: "a", status: "notInserted" }, START);
      await history.settled();
      await writeFile(stale, "{}");
      await chmod(dir, 0o300);
      await expect(history.setRetention("memory")).rejects.toThrow();
      await chmod(dir, 0o700);
      expect(await exists(file)).toBe(true);
      expect(await exists(stale)).toBe(true);
      expect(history.state().retention).toBe("month");
    },
  );

  test.skipIf(asRoot)(
    "a launch that cannot list the folder still loads the saved history and keeps it",
    async () => {
      await writeFile(file, envelope("forever", [savedEntry("earlier", START - HOUR)]));
      await chmod(dir, 0o300);
      const { history, logs } = harness();
      await history.loaded();
      expect(ids(history.entries())).toEqual(["earlier"]);
      history.remember({ id: "new", raw: "new", text: "new", status: "notInserted" }, START);
      await history.settled();
      await chmod(dir, 0o700);
      expect(ids((await saved()).entries)).toEqual(["new", "earlier"]);
      expect(logs).toEqual([expect.stringMatching(/^history: could not remove temp files/)]);
    },
  );

  test("a switch from memory tells the hub the history is saved only once the file holds it", async () => {
    const { history, published } = harness("memory");
    await history.settled();
    execFileSync("mkfifo", [file]);
    history.remember({ id: "a", raw: "a", text: "a", status: "notInserted" }, START);
    await history.settled();
    const move = history.setRetention("forever");
    await settledTick();
    await settledTick();
    expect(published.map((state) => state.retention)).not.toContain("forever");
    expect(history.state().retention).toBe("memory");

    await writeFile(file, envelope("day", []));
    await move;
    await settledTick();
    expect(published.at(-1)).toMatchObject({ retention: "forever", saveFailed: false });
    expect(ids((await saved()).entries)).toEqual(["a"]);
  });

  test("a clear queued behind a switch from memory claims nothing saved before the file is gone", async () => {
    const claims: { retention: HistoryRetention; fifo: boolean }[] = [];
    const history = createHistory({
      file,
      log: () => {},
      onChange: (state) => {
        let fifo = false;
        try {
          fifo = statSync(file).isFIFO();
        } catch {}
        claims.push({ retention: state.retention, fifo });
      },
      now: () => START,
    });
    await history.settled();
    execFileSync("mkfifo", [file]);
    history.remember({ id: "a", raw: "a", text: "a", status: "notInserted" }, START);
    await history.settled();
    const move = history.setRetention("forever");
    const cleared = history.clear();
    history.remember({ id: "survivor", raw: "s", text: "s", status: "notInserted" }, START + 1);
    await settledTick();

    await writeFile(file, envelope("day", []));
    await move;
    await cleared;
    await history.settled();
    await settledTick();
    expect(claims).not.toContainEqual({ retention: "forever", fifo: true });
    expect(ids(history.entries())).toEqual(["survivor"]);
    expect(ids((await saved()).entries)).toEqual(["survivor"]);
    expect(history.state()).toMatchObject({ retention: "forever", saveFailed: false });
  });

  test("expire drops an entry whose window ended while the timer slept", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { history, state, published } = harness("day");
    history.remember({ id: "a", raw: "a", text: "a", status: "notInserted" }, START);
    await history.settled();
    await settledTick();
    expect(ids(published.at(-1)?.entries ?? [])).toEqual(["a"]);

    state.now = START + DAY + HOUR;
    history.expire();
    await settledTick();
    expect(published.at(-1)?.entries).toEqual([]);
    await history.settled();
    expect((await saved()).entries).toEqual([]);
  });

  test("a delete that cannot reach the file keeps the row, and trying again deletes it", async () => {
    const { history } = harness("month");
    history.remember({ id: "a", raw: "a", text: "a", status: "notInserted" }, START);
    await history.settled();
    await blockWrites();
    await expect(history.remove("a")).rejects.toThrow();
    expect(ids(history.entries())).toEqual(["a"]);
    expect(history.state().saveFailed).toBe(false);

    await unblockWrites();
    await history.remove("a");
    expect(history.entries()).toEqual([]);
    expect((await saved()).entries).toEqual([]);
  });

  test("a clear that cannot write the file keeps the rows, and trying again clears them", async () => {
    const { history } = harness("month");
    history.remember({ id: "a", raw: "a", text: "a", status: "notInserted" }, START);
    await history.settled();
    const contents = await readFile(file, "utf8");
    await rm(file);
    await mkdir(file);
    await expect(history.clear()).rejects.toThrow();
    expect(ids(history.entries())).toEqual(["a"]);

    await rm(file, { recursive: true });
    await writeFile(file, contents);
    await history.clear();
    expect(history.entries()).toEqual([]);
    expect((await saved()).entries).toEqual([]);
  });

  test("keeps only the well-formed entries of a file", async () => {
    const good = { id: "ok", at: START, raw: "ok", text: "ok", status: "inserted" };
    await writeFile(
      file,
      envelope("month", [
        good,
        { ...good, status: "lost" },
        { ...good, id: "" },
        { ...good, id: "no-time", at: "noon" },
        { ...good, id: "no-text", text: null },
        { ...good, raw: "duplicate" },
        "junk",
      ]),
    );
    const { history } = harness();
    await history.settled();
    expect(history.entries()).toEqual([good]);
    expect(history.state()).toMatchObject({ retention: "month", saveFailed: false });
  });

  test("prunes on load from the file too, not only from the list", async () => {
    await writeFile(
      file,
      envelope("day", [savedEntry("old", START - 2 * DAY), savedEntry("recent", START - HOUR)]),
    );
    const { history } = harness();
    await history.settled();
    expect(ids((await saved()).entries)).toEqual(["recent"]);
  });

  test("a clear deletes a file it had to leave alone, and saving starts over after it", async () => {
    await writeFile(file, JSON.stringify({ version: 2, retention: "day", entries: [] }));
    const { history } = harness();
    await history.clear();
    expect(await exists(file)).toBe(false);
    expect(history.state()).toMatchObject({ retention: "memory", saveFailed: false });

    await history.setRetention("month");
    history.remember({ id: "a", raw: "a", text: "a", status: "pending" }, START);
    await history.settled();
    expect(ids((await saved()).entries)).toEqual(["a"]);
    expect(history.state()).toMatchObject({ retention: "month", saveFailed: false });
  });

  test("a clear before the saved history loads covers it, and it never comes back", async () => {
    await writeFile(file, envelope("month", [savedEntry("old", START - HOUR)]));
    const { history } = harness();
    const clearing = history.clear();
    history.remember({ id: "new", raw: "new", text: "new", status: "pending" }, START);
    await clearing;
    await history.settled();
    expect(ids(history.entries())).toEqual(["new"]);
    expect(ids((await saved()).entries)).toEqual(["new"]);
  });

  test("an entry deleted before the saved history loads stays deleted", async () => {
    await writeFile(file, envelope("month", [savedEntry("old", START - HOUR)]));
    const { history } = harness();
    history.remember({ id: "new", raw: "new", text: "new", status: "pending" }, START);
    await history.remove("new");
    await history.settled();
    expect(ids(history.entries())).toEqual(["old"]);
    expect(ids((await saved()).entries)).toEqual(["old"]);
  });

  test("drops saved entries whose time no date can hold", async () => {
    await writeFile(
      file,
      envelope("forever", [savedEntry("ok", START), savedEntry("beyond", 8_640_000_000_000_001)]),
    );
    const { history } = harness();
    await history.settled();
    expect(ids(history.entries())).toEqual(["ok"]);
  });

  test("a failed save says so until a later one lands, and leaves no temp file behind", async () => {
    const { history, published } = harness("month");
    await history.settled();
    await blockWrites();
    history.remember({ id: "a", raw: "a", text: "a", status: "pending" }, START);
    await history.settled();
    await settledTick();
    expect(history.state().saveFailed).toBe(true);
    expect(published.at(-1)?.saveFailed).toBe(true);
    expect(await tempFiles()).toEqual([]);

    await unblockWrites();
    history.settle("a", true);
    await history.settled();
    await settledTick();
    expect(history.state().saveFailed).toBe(false);
    expect(published.at(-1)?.saveFailed).toBe(false);
    expect(ids((await saved()).entries)).toEqual(["a"]);
  });

  test("a clear and a switch to memory also remove temp files a crash left behind", async () => {
    const stale = NodePath.join(dir, "history.json.12345.tmp");
    const { history } = harness("month");
    history.remember({ id: "a", raw: "a", text: "a", status: "notInserted" }, START);
    await history.settled();
    await writeFile(stale, "{}");
    await history.clear();
    expect(await tempFiles()).toEqual([]);

    history.remember({ id: "b", raw: "b", text: "b", status: "notInserted" }, START);
    await history.settled();
    await writeFile(stale, "{}");
    await history.setRetention("memory");
    expect(await tempFiles()).toEqual([]);
    expect(await exists(file)).toBe(false);
  });

  test("launch removes temp files a crash left behind before it writes", async () => {
    await writeFile(NodePath.join(dir, "history.json.12345.tmp"), "{}");
    const { history } = harness("month");
    await history.settled();
    expect(await tempFiles()).toEqual([]);
  });

  test("a shorter window that fails to save keeps every entry and the old window", async () => {
    const { history, state } = harness("forever");
    history.remember(
      { id: "old", raw: "old", text: "old", status: "notInserted" },
      START - 2 * DAY,
    );
    history.remember({ id: "new", raw: "new", text: "new", status: "notInserted" }, START);
    await history.settled();
    await blockWrites();

    await expect(history.setRetention("day")).rejects.toThrow();
    expect(ids(history.entries())).toEqual(["new", "old"]);
    expect(history.state()).toMatchObject({ retention: "forever", saveFailed: false });

    await unblockWrites();
    state.now = START + 1;
    history.remember(
      { id: "newer", raw: "newer", text: "newer", status: "notInserted" },
      START + 1,
    );
    await history.settled();
    expect(ids((await saved()).entries)).toEqual(["newer", "new", "old"]);
    expect((await saved()).retention).toBe("forever");
  });

  test("a switch from memory that fails to save keeps the history in memory", async () => {
    const { history } = harness("memory");
    history.remember({ id: "a", raw: "a", text: "a", status: "notInserted" }, START);
    await blockWrites();

    await expect(history.setRetention("month")).rejects.toThrow();
    expect(history.state().saveFailed).toBe(false);
    expect(ids(history.entries())).toEqual(["a"]);

    await unblockWrites();
    history.remember({ id: "b", raw: "b", text: "b", status: "notInserted" }, START);
    await history.settled();
    expect(await exists(file)).toBe(false);
  });

  test("a switch to memory that cannot delete the file keeps saving", async () => {
    const { history } = harness("month");
    history.remember({ id: "a", raw: "a", text: "a", status: "notInserted" }, START);
    await history.settled();
    const contents = await readFile(file, "utf8");
    await rm(file);
    await mkdir(file);
    await expect(history.setRetention("memory")).rejects.toThrow();

    await rm(file, { recursive: true });
    await writeFile(file, contents);
    history.remember({ id: "b", raw: "b", text: "b", status: "notInserted" }, START);
    await history.settled();
    expect(ids((await saved()).entries)).toEqual(["b", "a"]);
  });

  test("never writes transcript text to its logs, even when a save fails", async () => {
    const { history, logs } = harness("month");
    await history.settled();
    await blockWrites();
    history.remember(
      { id: "a", raw: "my bank pin", text: "My bank PIN.", status: "pending" },
      START,
    );
    await history.settled();
    expect(logs.some((line) => line.startsWith("history: save failed"))).toBe(true);
    expect(logs.join("\n")).not.toMatch(/bank/i);
  });
});

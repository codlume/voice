import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { parseBundleId, type BundleId } from "../shared/app-categories.ts";
import { EMPTY_INSIGHTS, type DayKey, type Insights } from "../shared/insights.ts";
import type { Dictated } from "./dictation.ts";
import { add, createInsights, parseInsights, tally, type Tally } from "./insights.ts";

const saves = vi.hoisted(() => ({ hold: Promise.resolve(), started: [] as Promise<void>[] }));
vi.mock("./atomic-file.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./atomic-file.ts")>();
  return {
    writeFileAtomic: (file: string, text: string) => {
      const write = saves.hold.then(() => real.writeFileAtomic(file, text));
      saves.started.push(write);
      return write;
    },
  };
});

const at = (day: string, time = "12:00") => new Date(`${day}T${time}:00`).getTime();

const dictated = (patch: Partial<Dictated> = {}): Dictated => ({
  raw: "hello there",
  insertedCleanup: null,
  dictionaryFixes: 0,
  language: "en",
  paceMs: 1000,
  finishedAt: at("2026-10-13"),
  destination: null,
  ...patch,
});

const day = (key: string) => key as DayKey;
const apps = (entries: Record<string, number>) => entries as Record<BundleId, number>;
const zeros = EMPTY_INSIGHTS.categories;
const mail = { bundleId: parseBundleId("com.apple.mail")!, category: "email" } as const;
const tallied = (patch: Partial<Tally> = {}): Tally => ({
  day: day("2026-10-13"),
  words: 5,
  corrected: 0,
  dictionaryFixes: 0,
  pace: null,
  destination: null,
  ...patch,
});

const where = (value: Insights) => ({
  days: value.days,
  categories: value.categories,
  apps: value.apps,
});
const used: Pick<Insights, "categories" | "apps"> = {
  categories: { ...zeros, work: { words: 120, sessions: 4 }, email: { words: 30, sessions: 1 } },
  apps: apps({ "com.tinyspeck.slackmacgap": 120, "com.apple.mail": 30 }),
};

describe("tally", () => {
  test("counts the words that were said, not the text a snippet expanded into", () => {
    expect(tally(dictated({ raw: "sig" })).words).toBe(1);
    expect(tally(dictated({ raw: "Well, it's 3 o'clock — see https://x.io!" })).words).toBe(7);
  });

  test("counts words cleanup removed or changed, only when its output was inserted", () => {
    const raw = "um so I I think we're gonna ship it";
    expect(
      tally(dictated({ raw, insertedCleanup: "So I think we're going to ship it." })).corrected,
    ).toBe(3);
    expect(tally(dictated({ raw, insertedCleanup: null })).corrected).toBe(0);
    expect(
      tally(
        dictated({ raw: "I don't think it's ready", insertedCleanup: "I don’t think it’s ready." }),
      ).corrected,
    ).toBe(0);
    expect(tally(dictated({ raw: "hello there", insertedCleanup: "Hello there." })).corrected).toBe(
      0,
    );
    expect(
      tally(dictated({ raw: "ŻÓŁW idzie", insertedCleanup: "Żółw idzie.", language: "pl" }))
        .corrected,
    ).toBe(0);
  });

  test("uses the speech span for pace and makes no sample without words or time", () => {
    expect(tally(dictated({ raw: "one two three", paceMs: 1500.4 })).pace).toEqual({
      words: 3,
      ms: 1500,
    });
    expect(tally(dictated({ raw: "…?!" })).pace).toBeNull();
    expect(tally(dictated({ paceMs: null })).pace).toBeNull();
    expect(tally(dictated({ paceMs: 0 })).pace).toBeNull();
  });

  test("keys a session by the local date it finished on", () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(tally(dictated({ finishedAt: at("2026-10-13", "23:59") })).day).toBe("2026-10-13");
      expect(tally(dictated({ finishedAt: at("2026-10-14", "00:01") })).day).toBe("2026-10-14");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});

describe("add", () => {
  test("sums a day's words and keeps only the newest pace samples", () => {
    let insights: Insights = EMPTY_INSIGHTS;
    for (let words = 1; words <= 101; words += 1) {
      insights = add(insights, {
        day: day(words <= 50 ? "2026-10-12" : "2026-10-13"),
        words,
        corrected: 1,
        dictionaryFixes: 2,
        pace: { words, ms: 1000 },
        destination: null,
      });
    }
    expect(insights.days).toEqual({ "2026-10-12": 1275, "2026-10-13": 3876 });
    expect(insights.corrected).toBe(101);
    expect(insights.dictionaryFixes).toBe(202);
    expect(insights.recent).toHaveLength(100);
    expect(insights.recent[0]).toEqual({ words: 2, ms: 1000 });
    expect(insights.recent.at(-1)).toEqual({ words: 101, ms: 1000 });
  });

  test("a session with no words adds no active day, category, or app", () => {
    expect(add(EMPTY_INSIGHTS, tallied({ words: 0, destination: mail }))).toEqual(EMPTY_INSIGHTS);
  });

  test("adds a session's words to its category and app, and one dictation to the category", () => {
    const counted = add({ ...EMPTY_INSIGHTS, ...used }, tallied({ destination: mail }));
    expect(counted.categories).toEqual({ ...used.categories, email: { words: 35, sessions: 2 } });
    expect(counted.apps).toEqual({ ...used.apps, "com.apple.mail": 35 });
  });

  test("a session with no known app counts toward the day but not toward any category or app", () => {
    const counted = add({ ...EMPTY_INSIGHTS, ...used }, tallied());
    expect(counted.days).toEqual({ "2026-10-13": 5 });
    expect(counted.categories).toEqual(used.categories);
    expect(counted.apps).toEqual(used.apps);
  });
});

describe("parseInsights", () => {
  test("keeps every well-formed field and drops the rest", () => {
    expect(
      parseInsights({
        version: 1,
        days: {
          "2026-10-13": 40,
          "2026-02-30": 5,
          yesterday: 3,
          "2026-10-12": -1,
          "2026-10-11": 2.5,
        },
        corrected: "many",
        dictionaryFixes: 4,
        recent: [{ words: 10, ms: 4000 }, { words: 0, ms: 10 }, "x", { words: 3 }],
      }),
    ).toEqual({
      days: { "2026-10-13": 40 },
      corrected: 0,
      dictionaryFixes: 4,
      recent: [{ words: 10, ms: 4000 }],
      categories: zeros,
      apps: {},
    });
    for (const raw of [null, 7, "x", []]) expect(parseInsights(raw)).toEqual(EMPTY_INSIGHTS);
  });

  test("keeps well-formed usage and drops the rest", () => {
    expect(
      parseInsights({
        version: 2,
        categories: {
          work: { words: 120, sessions: 4 },
          email: { words: 30, sessions: 1 },
          personal: { words: -3, sessions: 1 },
          other: "lots",
          gaming: { words: 9, sessions: 9 },
        },
        apps: {
          "com.tinyspeck.slackmacgap": 120,
          "com.apple.mail": 30,
          "com.apple.notes": 0,
          "com.apple.safari": -2,
          "com.apple.textedit": 1.5,
          "not a bundle id": 7,
        },
      }),
    ).toEqual({ ...EMPTY_INSIGHTS, ...used });
  });

  test("keeps only the newest pace samples of a hand-edited file", () => {
    const recent = Array.from({ length: 150 }, (_, i) => ({ words: i + 1, ms: 1000 }));
    const parsed = parseInsights({ recent });
    expect(parsed.recent).toHaveLength(100);
    expect(parsed.recent[0]).toEqual({ words: 51, ms: 1000 });
  });
});

describe("createInsights", () => {
  let dir: string;
  let file: string;
  let changes: Insights[];
  let logs: string[];

  beforeEach(async () => {
    dir = await mkdtemp(NodePath.join(tmpdir(), "voice-insights-"));
    file = NodePath.join(dir, "insights.json");
    changes = [];
    logs = [];
    saves.hold = Promise.resolve();
    saves.started = [];
  });
  afterEach(async () => {
    await chmod(dir, 0o700);
    await chmod(file, 0o600).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  const open = () =>
    createInsights({
      file,
      log: (message) => logs.push(message),
      onChange: (value) => changes.push(value),
    });
  const saved = async () => JSON.parse(await readFile(file, "utf8")) as unknown;
  const exists = () =>
    stat(file).then(
      () => true,
      () => false,
    );

  test("counts and saves on a later turn, never during the call", async () => {
    const insights = open();
    await insights.get();
    let read = false;
    const session = dictated();
    insights.record({
      ...session,
      get raw() {
        read = true;
        return session.raw;
      },
    });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(read).toBe(false);
    expect(changes).toEqual([]);
    await insights.settled();
    expect(read).toBe(true);
    const value = {
      days: { "2026-10-13": 2 },
      corrected: 0,
      dictionaryFixes: 0,
      recent: [{ words: 2, ms: 1000 }],
      categories: zeros,
      apps: {},
    };
    expect(await saved()).toEqual({ version: 2, ...value });
    expect(changes).toEqual([value]);
    expect(await insights.get()).toEqual(value);
  });

  test("a version 1 file is read without a write, and saved as version 2 with every field", async () => {
    const original = `${JSON.stringify({
      version: 1,
      days: { "2026-10-12": 500 },
      corrected: 9,
      dictionaryFixes: 3,
      recent: [{ words: 40, ms: 12_000 }],
    })}\n`;
    await writeFile(file, original);
    const insights = open();
    const migrated = {
      days: { "2026-10-12": 500 },
      corrected: 9,
      dictionaryFixes: 3,
      recent: [{ words: 40, ms: 12_000 }],
      categories: zeros,
      apps: {},
    };
    expect(await insights.get()).toEqual(migrated);
    await insights.settled();
    expect(await readFile(file, "utf8")).toBe(original);

    insights.record(dictated({ paceMs: null }));
    await insights.settled();
    const upgraded = { ...migrated, days: { "2026-10-12": 500, "2026-10-13": 2 } };
    expect(await saved()).toEqual({ version: 2, ...upgraded });
    expect(await open().get()).toEqual(upgraded);
  });

  test("a version 2 file keeps its usage through a session and a restart", async () => {
    await writeFile(file, JSON.stringify({ version: 2, ...EMPTY_INSIGHTS, ...used }));
    const insights = open();
    expect(await insights.get()).toMatchObject(used);
    insights.record(dictated());
    await insights.settled();
    expect(await saved()).toMatchObject({ version: 2, ...used });
    expect(await open().get()).toMatchObject(used);
  });

  test("an app whose id is an Object.prototype name survives a load", async () => {
    await writeFile(file, `{"version":2,"apps":{"__proto__":7}}`);
    expect((await open().get()).apps).toEqual(apps({ ["__proto__"]: 7 }));
  });

  test("two spellings of one app id in a hand-edited file add up", async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        ...EMPTY_INSIGHTS,
        apps: { "com.Apple.Mail": 7, "com.apple.mail": 11 },
      }),
    );
    expect((await open().get()).apps).toEqual(apps({ "com.apple.mail": 18 }));
  });

  test("a session recorded while the file loads is added to what the file held", async () => {
    await writeFile(
      file,
      JSON.stringify({ version: 1, days: { "2026-10-12": 500 }, corrected: 9 }),
    );
    const insights = open();
    insights.record(dictated({ raw: "one two three", insertedCleanup: "One, two." }));
    await insights.settled();
    expect(await saved()).toMatchObject({
      days: { "2026-10-12": 500, "2026-10-13": 3 },
      corrected: 10,
    });
  });

  test("a clear forgets a session not yet counted, and keeps the one after it", async () => {
    await writeFile(file, JSON.stringify({ version: 2, ...EMPTY_INSIGHTS, ...used }));
    const insights = open();
    insights.record(dictated({ raw: "before the clear" }));
    await insights.clear();
    insights.record(dictated({ raw: "after" }));
    await insights.settled();
    const after = { days: { "2026-10-13": 1 }, categories: zeros, apps: {} };
    expect(where((await saved()) as Insights)).toEqual(after);
    expect(changes.map(where)).toEqual([{ days: {}, categories: zeros, apps: {} }, after]);
    expect(where(await open().get())).toEqual(after);
  });

  test("a clear removes a session whose save was still in flight", async () => {
    await writeFile(file, JSON.stringify({ version: 2, ...EMPTY_INSIGHTS, ...used }));
    const insights = open();
    let release!: () => void;
    saves.hold = new Promise((resolve) => (release = resolve));
    insights.record(dictated());
    await vi.waitFor(() => expect(saves.started).toHaveLength(1));
    const cleared = insights.clear();
    release();
    await cleared;
    await insights.settled();
    await Promise.all(saves.started);
    expect(await exists()).toBe(false);
    expect(await insights.get()).toEqual(EMPTY_INSIGHTS);
    expect(await open().get()).toEqual(EMPTY_INSIGHTS);
  });

  test("the saved file holds no dictated words", async () => {
    const insights = open();
    insights.record(
      dictated({ raw: "zanzibar quokka", insertedCleanup: "Zanzibar quokka.", dictionaryFixes: 1 }),
    );
    await insights.settled();
    const text = await readFile(file, "utf8");
    expect(text).not.toMatch(/zanzibar|quokka/i);
  });

  test("the saved file counts the browser a website was dictated into, never the website", async () => {
    const insights = open();
    const chrome = { bundleId: parseBundleId("com.google.Chrome")!, host: "mail.google.com" };
    insights.record(dictated({ destination: { ...chrome, category: "email" } }));
    await insights.settled();
    expect(await saved()).toMatchObject({
      categories: { email: { words: 2, sessions: 1 } },
      apps: { "com.google.chrome": 2 },
    });
    expect(await readFile(file, "utf8")).not.toContain("mail.google.com");
  });

  test("a file Voice could not read is never written over", async () => {
    const original = JSON.stringify({ days: { "2026-10-01": 900 } });
    await writeFile(file, original);
    await chmod(file, 0o000);
    const insights = open();
    insights.record(dictated());
    await insights.settled();
    await chmod(file, 0o600);
    expect(await readFile(file, "utf8")).toBe(original);
    expect(await insights.get()).toEqual(EMPTY_INSIGHTS);
    expect(logs.some((line) => line.startsWith("insights: could not read the file"))).toBe(true);
  });

  test("a file from a newer format is never written over", async () => {
    const original = `${JSON.stringify({ version: 3, days: { "2026-10-12": 40 }, futureCounter: 9 })}\n`;
    await writeFile(file, original);
    const insights = open();
    insights.record(dictated());
    await insights.settled();
    expect(await readFile(file, "utf8")).toBe(original);
    expect(await insights.get()).toEqual(EMPTY_INSIGHTS);
    await insights.clear();
    expect(await exists()).toBe(false);
  });

  test("a file with a malformed version is kept, and a clear starts counting again", async () => {
    const original = `{"version":{"toString":null},"days":{"2026-10-12":40}}\n`;
    await writeFile(file, original);
    const insights = open();
    expect(await insights.get()).toEqual(EMPTY_INSIGHTS);
    insights.record(dictated());
    await insights.settled();
    expect(await readFile(file, "utf8")).toBe(original);
    await insights.clear();
    expect(await exists()).toBe(false);
    insights.record(dictated());
    await insights.settled();
    expect(await insights.get()).toMatchObject({ days: { "2026-10-13": 2 } });
  });

  test("a damaged file keeps its valid days, and one that is not JSON starts over", async () => {
    await writeFile(file, JSON.stringify({ days: { "2026-10-01": 900, nope: 1 }, recent: "x" }));
    const damaged = open();
    damaged.record(dictated());
    await damaged.settled();
    expect(await saved()).toMatchObject({ days: { "2026-10-01": 900, "2026-10-13": 2 } });

    await writeFile(file, "{ not json");
    const broken = open();
    broken.record(dictated());
    await broken.settled();
    expect(await saved()).toMatchObject({ days: { "2026-10-13": 2 } });
  });

  test("clearing twice resolves both times and leaves no file", async () => {
    const insights = open();
    insights.record(dictated());
    await insights.settled();
    await insights.clear();
    await insights.clear();
    expect(await exists()).toBe(false);
    expect(await insights.get()).toEqual(EMPTY_INSIGHTS);
  });

  test("a failed save is logged, and the next save repairs the file", async () => {
    const insights = open();
    await chmod(dir, 0o500);
    insights.record(dictated());
    await insights.settled();
    await chmod(dir, 0o700);
    expect(logs.some((line) => line.startsWith("insights: save failed"))).toBe(true);
    expect(await exists()).toBe(false);
    insights.record(dictated());
    await insights.settled();
    expect(await saved()).toMatchObject({ days: { "2026-10-13": 4 } });
  });

  test("the page ends on the count in memory even when the last save fails", async () => {
    const insights = open();
    insights.record(dictated());
    await insights.settled();
    await chmod(dir, 0o500);
    insights.record(dictated({ raw: "three more words" }));
    await insights.settled();
    await chmod(dir, 0o700);
    expect(await saved()).toMatchObject({ days: { "2026-10-13": 2 } });
    expect(changes.at(-1)).toEqual(await insights.get());
    expect(changes.at(-1)?.days).toEqual({ "2026-10-13": 5 });
  });
});

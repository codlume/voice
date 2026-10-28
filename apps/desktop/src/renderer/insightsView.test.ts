import { describe, expect, test, vi } from "vite-plus/test";

import { parseBundleId, type BundleId } from "../shared/app-categories.ts";
import { EMPTY_INSIGHTS, type DayKey, type Insights } from "../shared/insights.ts";
import {
  cellLabel,
  heatmap,
  insightsView,
  level,
  pace,
  stepDay,
  streaks,
  usage,
} from "./insightsView.ts";

// West of UTC, a local-time slip moves every cell a day early. CI runs in UTC, so pin the zone
// before the module builds its date formatters.
vi.hoisted(() => {
  process.env.TZ = "America/Los_Angeles";
});

const day = (key: string) => key as DayKey;
const days = (...keys: string[]) => Object.fromEntries(keys.map((key) => [key, 100]));
const byDay = (entries: Record<string, number>) => entries as Record<DayKey, number>;

describe("pace", () => {
  test("pools words and time instead of averaging each dictation's rate", () => {
    expect(
      pace([
        { words: 10, ms: 6000 },
        { words: 100, ms: 60_000 },
      ])?.wpm,
    ).toBe(100);
    expect(
      pace([
        { words: 10, ms: 3000 },
        { words: 100, ms: 60_000 },
      ])?.wpm,
    ).toBe(105);
  });

  test("shows from the first sample and tells how many it is based on", () => {
    expect(pace([])).toBeNull();
    expect(pace([{ words: 30, ms: 12_000 }])).toEqual({
      wpm: 150,
      sessions: 1,
      fasterThanTyping: 2.9,
    });
  });

  test("claims faster than typing only above the average typist", () => {
    expect(pace([{ words: 103, ms: 120_000 }])?.fasterThanTyping).toBeNull();
    expect(pace([{ words: 52, ms: 60_000 }])?.fasterThanTyping).toBeNull();
    expect(pace([{ words: 57, ms: 60_000 }])?.fasterThanTyping).toBe(1.1);
    expect(pace([{ words: 40, ms: 60_000 }])).toEqual({
      wpm: 40,
      sessions: 1,
      fasterThanTyping: null,
    });
  });
});

describe("streaks", () => {
  test("a day without words yet keeps yesterday's streak", () => {
    const history = days("2026-10-10", "2026-10-11", "2026-10-12");
    expect(streaks(history, day("2026-10-13"))).toEqual({ current: 3, longest: 3 });
    expect(streaks(byDay({ ...history, "2026-10-13": 5 }), day("2026-10-13"))).toEqual({
      current: 4,
      longest: 4,
    });
  });

  test("a missed day ends the current streak, and the longest run stays", () => {
    const history = days("2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-10-11");
    expect(streaks(history, day("2026-10-13"))).toEqual({ current: 0, longest: 4 });
    expect(streaks({}, day("2026-10-13"))).toEqual({ current: 0, longest: 0 });
  });

  test("a run across the spring and autumn clock changes counts every day", () => {
    const zone = process.env.TZ;
    process.env.TZ = "Europe/Warsaw";
    try {
      const march = days(
        "2026-03-07",
        "2026-03-08",
        "2026-03-09",
        "2026-03-28",
        "2026-03-29",
        "2026-03-30",
      );
      expect(streaks(march, day("2026-03-30"))).toEqual({ current: 3, longest: 3 });
      const autumn = days("2026-10-24", "2026-10-25", "2026-10-26");
      expect(streaks(autumn, day("2026-10-26"))).toEqual({ current: 3, longest: 3 });
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});

describe("heatmap", () => {
  test("rows run Sunday to Saturday and the last column ends with today", () => {
    const map = heatmap(byDay({ "2026-10-13": 40, "2026-10-04": 900 }), day("2026-10-13"), 3);
    expect(map.weeks).toHaveLength(3);
    expect(map.weeks[0]?.[0]?.day).toBe("2026-09-27");
    expect(map.weeks[1]?.[0]).toEqual({ day: "2026-10-04", words: 900, level: 4 });
    expect(map.weeks[2]?.map((cell) => cell?.day ?? null)).toEqual([
      "2026-10-11",
      "2026-10-12",
      "2026-10-13",
      null,
      null,
      null,
      null,
    ]);
    expect(map.weeks[2]?.[2]).toEqual({ day: "2026-10-13", words: 40, level: 1 });
  });

  test("a Saturday today fills the last column", () => {
    const map = heatmap({}, day("2026-10-17"), 1);
    expect(map.weeks[0]?.every((cell) => cell !== null)).toBe(true);
  });

  test("levels step at 1, 250, 500, and 750 words", () => {
    expect([0, 1, 249, 250, 499, 500, 749, 750, 5000].map(level)).toEqual([
      0, 1, 1, 2, 2, 3, 3, 4, 4,
    ]);
  });

  test("a month label sits on the column with the month's first day", () => {
    const map = heatmap({}, day("2026-10-13"), 8);
    expect(map.months.map(({ column }) => column)).toEqual([1, 5]);
    expect(map.weeks[1]?.[2]?.day).toBe("2026-09-01");
    expect(map.weeks[5]?.[4]?.day).toBe("2026-10-01");
    expect(heatmap({}, day("2026-08-13"), 3).months.map(({ column }) => column)).toEqual([0]);
  });

  test("a month that starts after today gets no label yet", () => {
    expect(heatmap({}, day("2026-09-30"), 1).months).toEqual([]);
  });
});

describe("insightsView", () => {
  test("totals words over every day and fixes over both kinds", () => {
    const view = insightsView(
      {
        ...EMPTY_INSIGHTS,
        days: byDay({ "2026-01-02": 1200, "2026-10-13": 34 }),
        corrected: 300,
        dictionaryFixes: 41,
      },
      day("2026-10-13"),
      53,
    );
    expect(view.totalWords).toBe(1234);
    expect(view.fixes).toEqual({ total: 341, corrected: 300, dictionaryFixes: 41 });
    expect(view.pace).toBeNull();
    expect(view.heatmap.weeks).toHaveLength(53);
  });

  test("an empty history shows zeros, no pace, and an empty grid", () => {
    const view = insightsView(EMPTY_INSIGHTS, day("2026-10-13"), 2);
    expect(view.totalWords).toBe(0);
    expect(view.streak).toEqual({ current: 0, longest: 0 });
    expect(view.heatmap.weeks.flat().every((cell) => cell === null || cell.level === 0)).toBe(true);
  });

  test("a cell's label names its words and its date", () => {
    expect(cellLabel({ day: day("2026-10-13"), words: 1, level: 1 })).toMatch(/^1 word on .+13/);
    expect(cellLabel({ day: day("2026-10-13"), words: 0, level: 0 })).toMatch(/^0 words on /);
  });
});

describe("stepDay", () => {
  const map = heatmap({}, day("2026-10-13"), 3);
  const step = (from: string, key: string) => stepDay(map, day(from), key);

  test("up and down move a day, across the column edge too", () => {
    expect(step("2026-10-07", "ArrowDown")).toBe("2026-10-08");
    expect(step("2026-10-07", "ArrowUp")).toBe("2026-10-06");
    expect(step("2026-10-10", "ArrowDown")).toBe("2026-10-11");
    expect(step("2026-10-04", "ArrowUp")).toBe("2026-10-03");
  });

  test("left and right move a week, never past today", () => {
    expect(step("2026-10-07", "ArrowLeft")).toBe("2026-09-30");
    expect(step("2026-10-07", "ArrowRight")).toBeNull();
    expect(step("2026-10-05", "ArrowRight")).toBe("2026-10-12");
  });

  test("Home and End reach the first day and today", () => {
    expect(step("2026-10-07", "Home")).toBe("2026-09-27");
    expect(step("2026-10-07", "End")).toBe("2026-10-13");
  });

  test("a key that would leave the grid or is not a move goes nowhere", () => {
    expect(step("2026-09-27", "ArrowUp")).toBeNull();
    expect(step("2026-09-29", "ArrowLeft")).toBeNull();
    expect(step("2026-10-13", "ArrowDown")).toBeNull();
    expect(step("2026-10-07", "Enter")).toBeNull();
    expect(step("2026-01-01", "ArrowDown")).toBeNull();
  });
});

const id = (raw: string): BundleId => {
  const bundleId = parseBundleId(raw);
  if (bundleId === null) throw new Error(`not a bundle id: ${raw}`);
  return bundleId;
};
const used = (patch: Partial<Insights>): Insights => ({ ...EMPTY_INSIGHTS, ...patch });
const categories = (patch: Partial<Insights["categories"]>) => ({
  ...EMPTY_INSIGHTS.categories,
  ...patch,
});

const noNames = (bundleId: BundleId) => bundleId;

describe("usage", () => {
  test("shares go by words, not by how many dictations", () => {
    const view = usage(
      used({
        categories: categories({
          personal: { words: 10, sessions: 9 },
          work: { words: 90, sessions: 1 },
        }),
      }),
      noNames,
    );
    expect(view.empty).toBe(false);
    expect(view.categories).toEqual([
      { category: "work", words: 90, sessions: 1, share: 90 },
      { category: "personal", words: 10, sessions: 9, share: 10 },
      { category: "email", words: 0, sessions: 0, share: 0 },
      { category: "other", words: 0, sessions: 0, share: 0 },
    ]);
  });

  test("shares always add up to 100, with ties broken in category order", () => {
    const third = { words: 1, sessions: 1 };
    const view = usage(
      used({ categories: categories({ email: third, work: third, personal: third }) }),
      noNames,
    );
    expect(view.categories.map(({ category, share }) => [category, share])).toEqual([
      ["personal", 34],
      ["work", 33],
      ["email", 33],
      ["other", 0],
    ]);
  });

  test("nothing attributed shows the empty state with every share at zero", () => {
    for (const insights of [
      EMPTY_INSIGHTS,
      used({ days: { [day("2026-10-12")]: 500 }, recent: [{ words: 40, ms: 12_000 }] }),
    ]) {
      const view = usage(insights, noNames);
      expect(view.empty).toBe(true);
      expect(view.appsUsed).toBe(0);
      expect(view.topApps).toEqual([]);
      expect(view.categories.map(({ category, share }) => [category, share])).toEqual([
        ["personal", 0],
        ["work", 0],
        ["email", 0],
        ["other", 0],
      ]);
    }
  });

  test("counts every app used and lists the five with the most words", () => {
    const words = [5, 40, 1, 20, 9, 25];
    const apps = Object.fromEntries(words.map((n, i) => [id(`com.example.app${i}`), n]));
    const view = usage(
      used({ categories: categories({ other: { words: 100, sessions: 6 } }), apps }),
      noNames,
    );
    expect(view.appsUsed).toBe(6);
    expect(view.topApps).toEqual([
      { bundleId: "com.example.app1", name: "com.example.app1", share: 40 },
      { bundleId: "com.example.app5", name: "com.example.app5", share: 25 },
      { bundleId: "com.example.app3", name: "com.example.app3", share: 20 },
      { bundleId: "com.example.app4", name: "com.example.app4", share: 9 },
      { bundleId: "com.example.app0", name: "com.example.app0", share: 5 },
    ]);
  });

  test("an app with under half a percent of the words never shows 0%", () => {
    const words = [9878, 100, 12, 10];
    const apps = Object.fromEntries(words.map((n, i) => [id(`com.example.app${i}`), n]));
    const view = usage(
      used({ categories: categories({ other: { words: 10_000, sessions: 4 } }), apps }),
      noNames,
    );
    expect(view.topApps.map(({ share }) => share)).toEqual([99, 1, 0.12, 0.1]);
  });

  test("a category with a few words never shows 0%", () => {
    const view = usage(
      used({
        categories: categories({
          other: { words: 9990, sessions: 460 },
          work: { words: 10, sessions: 1 },
        }),
      }),
      noNames,
    );
    expect(view.categories.map(({ category, share }) => [category, share])).toEqual([
      ["other", 100],
      ["work", 0.1],
      ["personal", 0],
      ["email", 0],
    ]);
  });
});

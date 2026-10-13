import { describe, expect, test } from "vite-plus/test";

import { EMPTY_INSIGHTS, type DayKey } from "../shared/insights.ts";
import { cellLabel, heatmap, insightsView, level, pace, stepDay, streaks } from "./insightsView.ts";

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
  });

  test("a month that starts after today gets no label yet", () => {
    expect(heatmap({}, day("2026-09-30"), 1).months).toEqual([]);
  });
});

describe("insightsView", () => {
  test("totals words over every day and fixes over both kinds", () => {
    const view = insightsView(
      {
        days: byDay({ "2026-01-02": 1200, "2026-10-13": 34 }),
        corrected: 300,
        dictionaryFixes: 41,
        recent: [],
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

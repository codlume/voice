import { describe, expect, test } from "vite-plus/test";

import type { HistoryEntry } from "../shared/history.ts";
import { dayKey } from "../shared/insights.ts";
import { droppedBy, historyPage, msUntilNextDay, timeLabel } from "./historyView.ts";

const ZONE_WEST_OF_UTC = "America/Los_Angeles";
process.env.TZ = ZONE_WEST_OF_UTC;

const entry = (id: string, at: Date, text: string, raw = text): HistoryEntry => ({
  id,
  at: at.getTime(),
  raw,
  text,
  status: "inserted",
});

const NOW = new Date(2026, 9, 14, 9, 30);
const TODAY = dayKey(NOW);
const page = (entries: readonly HistoryEntry[], query = "", limit = 100, today = TODAY) =>
  historyPage(entries, { query, limit, today }, "en-US");
const labels = ({ days }: ReturnType<typeof historyPage>) =>
  days.map(({ label, entries }) => [label, entries.map(({ id }) => id)]);

describe("history days", () => {
  test("split at local midnight into Today, Yesterday, then the long date", () => {
    const entries = [
      entry("morning", new Date(2026, 9, 14, 9, 0), "Ship it."),
      entry("after-midnight", new Date(2026, 9, 14, 0, 1), "Late one."),
      entry("before-midnight", new Date(2026, 9, 13, 23, 59), "Later one."),
      entry("older", new Date(2026, 9, 12, 11, 44), "Hello."),
    ];
    expect(labels(page(entries))).toEqual([
      ["Today", ["morning", "after-midnight"]],
      ["Yesterday", ["before-midnight"]],
      ["October 12, 2026", ["older"]],
    ]);
  });

  test("a day stays one group when its entries arrive out of order", () => {
    const entries = [
      entry("today-early", new Date(2026, 9, 14, 8, 0), "First."),
      entry("yesterday", new Date(2026, 9, 13, 18, 0), "Between."),
      entry("today-late", new Date(2026, 9, 14, 9, 0), "Second."),
    ];
    expect(labels(page(entries))).toEqual([
      ["Today", ["today-early", "today-late"]],
      ["Yesterday", ["yesterday"]],
    ]);
  });

  test("Yesterday reaches back across a month boundary", () => {
    const entries = [entry("halloween", new Date(2026, 9, 31, 22, 0), "Boo.")];
    expect(labels(page(entries, "", 100, dayKey(new Date(2026, 10, 1, 8, 0))))).toEqual([
      ["Yesterday", ["halloween"]],
    ]);
  });

  test("search ignores case and finds words that only the raw transcript has", () => {
    const entries = [
      entry("cleaned", NOW, "Push the launch to Friday.", "um push the uh launch to friday"),
      entry("other", NOW, "Lunch at noon."),
    ];
    expect(labels(page(entries, "  UH  "))).toEqual([["Today", ["cleaned"]]]);
    expect(labels(page(entries, "LAUNCH"))).toEqual([["Today", ["cleaned"]]]);
    expect(page(entries, "dinner")).toEqual({ days: [], hidden: 0 });
  });

  test("search drops days whose entries all miss", () => {
    const entries = [
      entry("today", NOW, "Standup notes."),
      entry("yesterday", new Date(2026, 9, 13, 10, 0), "Invoice for Ada."),
    ];
    expect(labels(page(entries, "invoice"))).toEqual([["Yesterday", ["yesterday"]]]);
  });
});

describe("time label", () => {
  test("reads as a short local clock time", () => {
    expect(timeLabel(new Date(2026, 9, 12, 11, 44).getTime(), "en-US")).toMatch(/^11:44\sAM$/u);
  });
});

describe("history page", () => {
  const hours = (count: number, text = (i: number) => `Note ${i}.`) =>
    Array.from({ length: count }, (_, i) =>
      entry(`e${i}`, new Date(NOW.getTime() - i * 3_600_000 * 7), text(i)),
    );

  test("shows the newest entries up to the limit, cutting the oldest day mid-way", () => {
    const entries = hours(6);
    expect(labels(page(entries, "", 4))).toEqual([
      ["Today", ["e0", "e1"]],
      ["Yesterday", ["e2", "e3"]],
    ]);
    expect(page(entries, "", 4).hidden).toBe(2);
    expect(page(entries, "", 6).hidden).toBe(0);
  });

  test("searches every entry before the limit and counts only hidden matches", () => {
    const entries = hours(6, (i) => (i % 2 === 0 ? `Invoice ${i}.` : `Lunch ${i}.`));
    const found = page(entries, "invoice", 2);
    expect(labels(found)).toEqual([
      ["Today", ["e0"]],
      ["Yesterday", ["e2"]],
    ]);
    expect(found.hidden).toBe(1);
  });
});

describe("msUntilNextDay", () => {
  test("lands one second past local midnight", () => {
    const now = new Date(2026, 9, 14, 23, 59, 30);
    const next = new Date(now.getTime() + msUntilNextDay(now));
    expect([next.getDate(), next.getHours(), next.getMinutes(), next.getSeconds()]).toEqual([
      15, 0, 0, 1,
    ]);
  });
});

describe("droppedBy", () => {
  const entries = [
    entry("now", NOW, "Now."),
    entry("day-edge", new Date(NOW.getTime() - 24 * 3_600_000), "A day old."),
    entry("week", new Date(NOW.getTime() - 7 * 24 * 3_600_000), "A week old."),
    entry("quarter", new Date(NOW.getTime() - 90 * 24 * 3_600_000), "A quarter old."),
  ];

  test("counts the entries a window drops, with the edge of the window dropped like main does", () => {
    const now = NOW.getTime();
    expect(droppedBy(entries, "day", now)).toBe(3);
    expect(droppedBy(entries, "month", now)).toBe(1);
    expect(droppedBy(entries, "forever", now)).toBe(0);
    expect(droppedBy(entries, "memory", now)).toBe(0);
    expect(droppedBy([], "day", now)).toBe(0);
  });
});

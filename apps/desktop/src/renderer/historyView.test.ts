import { describe, expect, test } from "vite-plus/test";

import type { HistoryEntry } from "../shared/history.ts";
import { dayKey, type DayKey } from "../shared/insights.ts";
import {
  historyDays,
  limitDays,
  msUntilNextDay,
  timeLabel,
  type HistoryDay,
} from "./historyView.ts";

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
const labels = (days: ReturnType<typeof historyDays>) =>
  days.map(({ label, entries }) => [label, entries.map(({ id }) => id)]);

describe("history days", () => {
  test("split at local midnight into Today, Yesterday, then the long date", () => {
    const entries = [
      entry("morning", new Date(2026, 9, 14, 9, 0), "Ship it."),
      entry("after-midnight", new Date(2026, 9, 14, 0, 1), "Late one."),
      entry("before-midnight", new Date(2026, 9, 13, 23, 59), "Later one."),
      entry("older", new Date(2026, 9, 12, 11, 44), "Hello."),
    ];
    expect(labels(historyDays(entries, "", TODAY, "en-US"))).toEqual([
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
    expect(labels(historyDays(entries, "", TODAY, "en-US"))).toEqual([
      ["Today", ["today-early", "today-late"]],
      ["Yesterday", ["yesterday"]],
    ]);
  });

  test("Yesterday reaches back across a month boundary", () => {
    const entries = [entry("halloween", new Date(2026, 9, 31, 22, 0), "Boo.")];
    expect(labels(historyDays(entries, "", dayKey(new Date(2026, 10, 1, 8, 0)), "en-US"))).toEqual([
      ["Yesterday", ["halloween"]],
    ]);
  });

  test("search ignores case and finds words that only the raw transcript has", () => {
    const entries = [
      entry("cleaned", NOW, "Push the launch to Friday.", "um push the uh launch to friday"),
      entry("other", NOW, "Lunch at noon."),
    ];
    expect(labels(historyDays(entries, "  UH  ", TODAY))).toEqual([["Today", ["cleaned"]]]);
    expect(labels(historyDays(entries, "LAUNCH", TODAY))).toEqual([["Today", ["cleaned"]]]);
    expect(historyDays(entries, "dinner", TODAY)).toEqual([]);
  });

  test("search drops days whose entries all miss", () => {
    const entries = [
      entry("today", NOW, "Standup notes."),
      entry("yesterday", new Date(2026, 9, 13, 10, 0), "Invoice for Ada."),
    ];
    expect(labels(historyDays(entries, "invoice", TODAY))).toEqual([["Yesterday", ["yesterday"]]]);
  });
});

describe("time label", () => {
  test("reads as a short local clock time", () => {
    expect(timeLabel(new Date(2026, 9, 12, 11, 44).getTime(), "en-US")).toMatch(/^11:44\sAM$/u);
  });
});

describe("limitDays", () => {
  const day = (name: string, count: number): HistoryDay => ({
    day: name as DayKey,
    label: name,
    entries: Array.from({ length: count }, (_, i) => entry(`${name}-${i}`, NOW, `${i}`)),
  });

  test("cuts the oldest days first and counts what it hides", () => {
    const days = [day("2026-10-14", 2), day("2026-10-13", 3), day("2026-10-12", 1)];
    const limited = limitDays(days, 4);
    expect(limited.days.map((d) => [d.day, d.entries.length])).toEqual([
      ["2026-10-14", 2],
      ["2026-10-13", 2],
    ]);
    expect(limited.hidden).toBe(2);
    expect(limitDays(days, 6)).toEqual({ days, hidden: 0 });
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

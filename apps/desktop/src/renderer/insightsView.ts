import type { InstalledApp } from "../shared/api.ts";
import {
  BUILT_IN_APPS,
  CATEGORIES,
  parseBundleId,
  type BundleId,
  type Category,
} from "../shared/app-categories.ts";
import type { DayKey, Insights, Pace, Usage } from "../shared/insights.ts";
import type { Assignment } from "../shared/style.ts";

/** The average typist, from Dhakal et al., CHI 2018, "Observations on Typing from 136M Keystrokes". */
export const TYPING_WPM = 51.56;

export type Level = 0 | 1 | 2 | 3 | 4;
type HeatmapCell = { day: DayKey; words: number; level: Level } | null;
export type Heatmap = {
  weeks: readonly (readonly HeatmapCell[])[];
  months: readonly { column: number; label: string }[];
};

type InsightsView = {
  pace: { wpm: number; sessions: number; fasterThanTyping: number | null } | null;
  totalWords: number;
  fixes: { total: number; corrected: number; dictionaryFixes: number };
  streak: { current: number; longest: number };
  heatmap: Heatmap;
};

export const DAY_MS = 86_400_000;

const utcDayNumber = (day: DayKey) => {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, date) / DAY_MS;
};
const keyOf = (dayIndex: number) =>
  new Date(dayIndex * DAY_MS).toISOString().slice(0, 10) as DayKey;

export function insightsView(insights: Insights, today: DayKey, weeks: number): InsightsView {
  const totalWords = Object.values(insights.days).reduce((sum, words) => sum + words, 0);
  return {
    pace: pace(insights.recent),
    totalWords,
    fixes: {
      total: insights.corrected + insights.dictionaryFixes,
      corrected: insights.corrected,
      dictionaryFixes: insights.dictionaryFixes,
    },
    streak: streaks(insights.days, today),
    heatmap: heatmap(insights.days, today, weeks),
  };
}

export function pace(recent: readonly Pace[]): InsightsView["pace"] {
  const words = recent.reduce((sum, sample) => sum + sample.words, 0);
  const ms = recent.reduce((sum, sample) => sum + sample.ms, 0);
  if (words === 0 || ms === 0) return null;
  const rate = words / (ms / 60_000);
  const times = Math.round((rate / TYPING_WPM) * 10) / 10;
  return {
    wpm: Math.round(rate),
    sessions: recent.length,
    fasterThanTyping: times > 1 ? times : null,
  };
}

export function streaks(days: Insights["days"], today: DayKey): InsightsView["streak"] {
  const active = new Set<number>();
  for (const [day, words] of Object.entries(days))
    if (words > 0) active.add(utcDayNumber(day as DayKey));
  let longest = 0;
  for (const day of active) {
    if (active.has(day - 1)) continue;
    let run = 1;
    while (active.has(day + run)) run += 1;
    longest = Math.max(longest, run);
  }
  let from = utcDayNumber(today);
  if (!active.has(from)) from -= 1;
  let current = 0;
  while (active.has(from - current)) current += 1;
  return { current, longest };
}

export function level(words: number): Level {
  if (words <= 0) return 0;
  if (words < 250) return 1;
  if (words < 500) return 2;
  if (words < 750) return 3;
  return 4;
}

const monthLabel = new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" });

export function heatmap(days: Insights["days"], today: DayKey, weeks: number): Heatmap {
  const last = utcDayNumber(today);
  const firstSunday = last - new Date(last * DAY_MS).getUTCDay() - 7 * (weeks - 1);
  const columns: HeatmapCell[][] = [];
  const months: { column: number; label: string }[] = [];
  for (let column = 0; column < weeks; column += 1) {
    const cells: HeatmapCell[] = [];
    for (let row = 0; row < 7; row += 1) {
      const dayIndex = firstSunday + 7 * column + row;
      if (dayIndex > last) {
        cells.push(null);
        continue;
      }
      const day = keyOf(dayIndex);
      const words = days[day] ?? 0;
      cells.push({ day, words, level: level(words) });
      const date = new Date(dayIndex * DAY_MS);
      if (date.getUTCDate() === 1) months.push({ column, label: monthLabel.format(date) });
    }
    columns.push(cells);
  }
  return { weeks: columns, months };
}

const cellDate = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

export function cellLabel(cell: NonNullable<HeatmapCell>): string {
  const words = cell.words === 1 ? "1 word" : `${cell.words.toLocaleString()} words`;
  return `${words} on ${cellDate.format(utcDayNumber(cell.day) * DAY_MS)}`;
}

const STEPS: Partial<Record<string, number>> = {
  ArrowUp: -1,
  ArrowDown: 1,
  ArrowLeft: -7,
  ArrowRight: 7,
};

export function stepDay(map: Heatmap, from: DayKey, key: string): DayKey | null {
  const days = map.weeks.flat().flatMap((cell) => (cell ? [cell.day] : []));
  const at = days.indexOf(from);
  if (at === -1) return null;
  const step = STEPS[key];
  const to =
    key === "Home" ? 0 : key === "End" ? days.length - 1 : step === undefined ? -1 : at + step;
  return days[to] ?? null;
}

const TOP_APPS = 5;

export type UsageView = {
  appsUsed: number;
  categories: readonly ({ category: Category; share: number } & Usage)[];
  topApps: readonly { bundleId: BundleId; name: string; share: number }[];
  empty: boolean;
};

function wholePercents(parts: readonly number[]): number[] {
  const total = parts.reduce((sum, part) => sum + part, 0);
  if (total === 0) return parts.map(() => 0);
  const result = parts.map((part) => Math.floor((part * 100) / total));
  let left = 100 - result.reduce((sum, share) => sum + share, 0);
  const byRemainder = parts
    .map((part, index) => ({ index, remainder: (part * 100) % total }))
    .toSorted((a, b) => b.remainder - a.remainder);
  for (const { index } of byRemainder) {
    if (left === 0) break;
    result[index] = (result[index] ?? 0) + 1;
    left -= 1;
  }
  return result;
}

export function usage(insights: Insights, name: (bundleId: BundleId) => string): UsageView {
  const categories = CATEGORIES.map((category) => {
    const { words, sessions } = insights.categories[category];
    return { category, words, sessions };
  }).toSorted((a, b) => b.words - a.words);
  const categoryShares = wholePercents(categories.map(({ words }) => words));
  const apps = Object.entries(insights.apps)
    .flatMap(([key, words]) => {
      const bundleId = parseBundleId(key);
      return bundleId !== null && words > 0 ? [{ bundleId, words }] : [];
    })
    .toSorted((a, b) => b.words - a.words);
  const appShares = wholePercents(apps.map(({ words }) => words));
  return {
    appsUsed: apps.length,
    categories: categories.map((row, index) => ({ ...row, share: categoryShares[index] ?? 0 })),
    topApps: apps.slice(0, TOP_APPS).map(({ bundleId }, index) => ({
      bundleId,
      name: name(bundleId),
      share: appShares[index] ?? 0,
    })),
    empty: categories.every(({ words }) => words === 0),
  };
}

export function appNames(
  assignments: readonly Assignment[],
  installed: readonly InstalledApp[],
): (bundleId: BundleId) => string {
  const names = new Map(installed.map(({ bundleId, name }) => [bundleId, name]));
  for (const { bundleId, name } of BUILT_IN_APPS) names.set(bundleId, name);
  for (const assignment of assignments) {
    if (assignment.kind === "app") names.set(assignment.bundleId, assignment.name);
  }
  return (bundleId) => names.get(bundleId) ?? bundleId;
}

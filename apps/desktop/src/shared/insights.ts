import type { BundleId, Category } from "./app-categories.ts";

export type DayKey = string & { readonly __brand: "DayKey" };

export type Pace = { words: number; ms: number };

export type Usage = { words: number; sessions: number };

export type Insights = {
  days: Readonly<Record<DayKey, number>>;
  corrected: number;
  dictionaryFixes: number;
  recent: readonly Pace[];
  categories: Readonly<Record<Category, Usage>>;
  apps: Readonly<Record<BundleId, number>>;
};

const UNUSED: Usage = { words: 0, sessions: 0 };

export const EMPTY_INSIGHTS: Insights = {
  days: {},
  corrected: 0,
  dictionaryFixes: 0,
  recent: [],
  categories: { personal: UNUSED, work: UNUSED, email: UNUSED, other: UNUSED },
  apps: {},
};
export const RECENT_SESSIONS = 100;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n: number) => String(n).padStart(2, "0");

export function dayKey(date: Date): DayKey {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` as DayKey;
}

export function isDayKey(value: string): value is DayKey {
  if (!DAY_KEY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

import { retentionMs, type HistoryEntry, type HistoryRetention } from "../shared/history.ts";
import { dayKey, type DayKey } from "../shared/insights.ts";

export type HistoryDay = { day: DayKey; label: string; entries: readonly HistoryEntry[] };

function matches(entry: HistoryEntry, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return true;
  return (
    entry.text.toLocaleLowerCase().includes(needle) ||
    entry.raw.toLocaleLowerCase().includes(needle)
  );
}

const localDate = (day: DayKey, offset = 0) => {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, date + offset);
};

export function dayLabel(day: DayKey, today: DayKey, locale?: string): string {
  if (day === today) return "Today";
  if (day === dayKey(localDate(today, -1))) return "Yesterday";
  return new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(localDate(day));
}

export function timeLabel(at: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(at);
}

/**
 * The newest `limit` entries that match `query`, grouped by local day, and how many matches the
 * limit hides. Entries arrive newest first, so cutting before grouping keeps the newest days.
 */
export function historyPage(
  entries: readonly HistoryEntry[],
  { query, limit, today }: { query: string; limit: number; today: DayKey },
  locale?: string,
): { days: HistoryDay[]; hidden: number } {
  const matched = entries.filter((entry) => matches(entry, query));
  const shown = matched.slice(0, limit);
  const days = Map.groupBy(shown, (entry) => dayKey(new Date(entry.at)));
  return {
    days: Array.from(days, ([day, dayEntries]) => ({
      day,
      label: dayLabel(day, today, locale),
      entries: dayEntries,
    })),
    hidden: matched.length - shown.length,
  };
}

/** Milliseconds until one second past the next local midnight. */
export function msUntilNextDay(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
  return next.getTime() - now.getTime();
}

/** How many entries a window would drop at `now`. The edge counts as dropped, as main prunes it. */
export function droppedBy(
  entries: readonly HistoryEntry[],
  retention: HistoryRetention,
  now: number,
): number {
  const cutoff = now - retentionMs[retention];
  return entries.filter((entry) => entry.at <= cutoff).length;
}

export const historyRetentions = ["memory", "day", "month", "forever"] as const;
export type HistoryRetention = (typeof historyRetentions)[number];

const DAY_MS = 86_400_000;

export const retentionMs: Record<HistoryRetention, number> = {
  memory: Infinity,
  day: DAY_MS,
  month: 30 * DAY_MS,
  forever: Infinity,
};

/**
 * `pending` is a transcript whose session is still cleaning or inserting it. Main settles it to
 * `inserted` or `notInserted` when the session ends.
 */
export type HistoryStatus = "pending" | "inserted" | "notInserted";

/** One session's transcript, newest first in the history. `at` is when the transcript arrived. */
export type HistoryEntry = {
  id: string;
  at: number;
  raw: string;
  text: string;
  status: HistoryStatus;
};

/** What a session hands the history: its transcript so far, never already inserted. */
export type Transcript = Pick<HistoryEntry, "id" | "raw" | "text"> & {
  status: Exclude<HistoryStatus, "inserted">;
};

/**
 * What the hub shows. `retention` is the window the store is on, which the settings only name
 * once it landed. `saveFailed` is true while that window keeps history on this Mac but this run's
 * entries are not all there, so a quit would lose some, and while a temp file a crash left, which
 * may hold a transcript, could not be removed.
 */
export type HistoryState = {
  entries: readonly HistoryEntry[];
  retention: HistoryRetention;
  saveFailed: boolean;
};

export const historySurvivesQuit = (retention: HistoryRetention, saveFailed: boolean) =>
  retention !== "memory" && !saveFailed;

/** How many entries a retention window would drop at `now`. */
export function droppedBy(
  entries: readonly HistoryEntry[],
  retention: HistoryRetention,
  now: number,
): number {
  const cutoff = now - retentionMs[retention];
  return entries.filter((entry) => entry.at <= cutoff).length;
}

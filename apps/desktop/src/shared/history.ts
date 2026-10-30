export const historyRetentions = ["memory", "day", "month", "forever"] as const;
export type HistoryRetention = (typeof historyRetentions)[number];

export const parseHistoryRetention = (value: unknown): HistoryRetention | null =>
  historyRetentions.find((retention) => retention === value) ?? null;

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

/**
 * What main tells the hub after a change. `all` carries the whole state: the first list of the
 * run, and one where more entries left than stayed, as after a clear. `patch` names only the
 * entries that moved since the last change, so a long history costs the main process nothing
 * per session; the hub applies it to the list it holds.
 */
export type HistoryChange =
  | { kind: "all"; state: HistoryState }
  | ({ kind: "patch"; upsert: readonly HistoryEntry[]; remove: readonly string[] } & Omit<
      HistoryState,
      "entries"
    >);

/** `entries` with `entry` at its place, newest first. */
export function insertEntry(
  entries: readonly HistoryEntry[],
  entry: HistoryEntry,
): readonly HistoryEntry[] {
  const after = entries.findIndex((other) => other.at <= entry.at);
  return after < 0 ? [...entries, entry] : entries.toSpliced(after, 0, entry);
}

export function applyHistoryChange(
  state: HistoryState | null,
  change: HistoryChange,
): HistoryState | null {
  if (change.kind === "all") return change.state;
  if (state === null) return null;
  const touched = new Set([...change.remove, ...change.upsert.map((entry) => entry.id)]);
  let entries: readonly HistoryEntry[] = state.entries.filter((entry) => !touched.has(entry.id));
  for (const entry of change.upsert) entries = insertEntry(entries, entry);
  return { entries, retention: change.retention, saveFailed: change.saveFailed };
}

export const historySurvivesQuit = (retention: HistoryRetention, saveFailed: boolean) =>
  retention !== "memory" && !saveFailed;

/** The newest entry when quitting now would lose it: never inserted, and not saved on this Mac. */
export const atRiskOnQuit = ({
  entries: [latest],
  retention,
  saveFailed,
}: HistoryState): HistoryEntry | null =>
  latest !== undefined &&
  latest.status !== "inserted" &&
  !historySurvivesQuit(retention, saveFailed)
    ? latest
    : null;

/** What a copy of an entry puts on the clipboard. Never an empty string: raw stands in for it. */
export const copyText = (entry: HistoryEntry) => entry.text || entry.raw;

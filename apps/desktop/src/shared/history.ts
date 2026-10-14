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

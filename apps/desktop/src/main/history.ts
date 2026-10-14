import type { HistoryEntry } from "../shared/history.ts";

export type Transcript = Pick<HistoryEntry, "id" | "raw" | "text"> & {
  status: "pending" | "notInserted";
};

export type History = {
  /** Adds the session's transcript, or replaces its text when cleanup finished. */
  remember(transcript: Transcript, at: number): void;
  /** Ends a pending entry. A session that produced no transcript has none, and nothing happens. */
  settle(id: string, inserted: boolean): void;
  entries(): readonly HistoryEntry[];
  remove(id: string): void;
  clear(): void;
};

export function createHistory(options: {
  onChange: (entries: readonly HistoryEntry[]) => void;
}): History {
  let entries: readonly HistoryEntry[] = [];
  let publishing = false;

  function change(next: readonly HistoryEntry[]) {
    entries = next;
    if (publishing) return;
    publishing = true;
    queueMicrotask(() => {
      publishing = false;
      options.onChange(entries);
    });
  }

  return {
    remember({ id, raw, text, status }, at) {
      change(
        entries.some((entry) => entry.id === id)
          ? entries.map((entry) => (entry.id === id ? { ...entry, raw, text, status } : entry))
          : [{ id, at, raw, text, status }, ...entries],
      );
    },
    settle(id, inserted) {
      if (!entries.some((entry) => entry.id === id && entry.status === "pending")) return;
      const status = inserted ? "inserted" : "notInserted";
      change(entries.map((entry) => (entry.id === id ? { ...entry, status } : entry)));
    },
    entries: () => entries,
    remove(id) {
      if (entries.some((entry) => entry.id === id))
        change(entries.filter((entry) => entry.id !== id));
    },
    clear() {
      if (entries.length > 0) change([]);
    },
  };
}

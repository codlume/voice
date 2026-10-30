import { useEffect, useState } from "react";

import { applyHistoryChange, type HistoryState } from "../shared/history.ts";
import { hubApi } from "./voice.ts";

/** Null until the first list arrives. The hub root waits for it, so pages never see null. */
export function useHistory(): HistoryState | null {
  const [history, setHistory] = useState<HistoryState | null>(null);
  useEffect(() => {
    // Main sends its answer and its changes in order, so a patch that arrives before the answer
    // is already in it and falls through, and the answer never replaces a list a change built.
    const unsubscribe = hubApi().onHistory((change) =>
      setHistory((current) => applyHistoryChange(current, change)),
    );
    void hubApi()
      .getHistory()
      .then((first) => setHistory((current) => current ?? first));
    return unsubscribe;
  }, []);
  return history;
}

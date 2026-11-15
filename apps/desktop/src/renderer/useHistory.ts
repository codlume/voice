import { useEffect, useState } from "react";

import { applyHistoryChange, type HistoryState } from "../shared/history.ts";
import { hubApi } from "./voice.ts";

/** Null until the first list arrives. The hub root waits for it, so pages never see null. */
export function useHistory(): HistoryState | null {
  const [history, setHistory] = useState<HistoryState | null>(null);
  useEffect(() => {
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

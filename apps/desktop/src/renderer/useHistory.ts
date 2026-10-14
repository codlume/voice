import { useEffect, useState } from "react";

import type { HistoryState } from "../shared/history.ts";
import { hubApi } from "./voice.ts";

/** Null until the first list arrives. The hub root waits for it, so pages never see null. */
export function useHistory(): HistoryState | null {
  const [history, setHistory] = useState<HistoryState | null>(null);
  useEffect(() => {
    let answerStale = false;
    const unsubscribe = hubApi().onHistory((next) => {
      answerStale = true;
      setHistory(next);
    });
    void hubApi()
      .getHistory()
      .then((first) => {
        if (!answerStale) setHistory(first);
      });
    return () => {
      answerStale = true;
      unsubscribe();
    };
  }, []);
  return history;
}

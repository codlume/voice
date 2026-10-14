import { useEffect, useReducer } from "react";

import { dayKey, type DayKey } from "../shared/insights.ts";
import { msUntilNextDay } from "./historyView.ts";

/** Today's key, re-read when the window comes back and when the local day turns over. */
export function useToday(): DayKey {
  const [, render] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    window.addEventListener("focus", render);
    document.addEventListener("visibilitychange", render);
    return () => {
      window.removeEventListener("focus", render);
      document.removeEventListener("visibilitychange", render);
    };
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const armForMidnight = () => {
      timer = setTimeout(() => {
        render();
        armForMidnight();
      }, msUntilNextDay(new Date()));
    };
    armForMidnight();
    return () => clearTimeout(timer);
  }, []);
  return dayKey(new Date());
}

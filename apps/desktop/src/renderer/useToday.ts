import { useEffect, useState } from "react";

import { dayKey, type DayKey } from "../shared/insights.ts";
import { msUntilNextDay } from "./historyView.ts";

/** Today's key, re-read when the window comes back and when the local day turns over. */
export function useToday(): DayKey {
  const [today, setToday] = useState(() => dayKey(new Date()));
  useEffect(() => {
    const sync = () => setToday(dayKey(new Date()));
    let timer: ReturnType<typeof setTimeout>;
    const armForMidnight = () => {
      timer = setTimeout(() => {
        sync();
        armForMidnight();
      }, msUntilNextDay(new Date()));
    };
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    armForMidnight();
    return () => {
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
      clearTimeout(timer);
    };
  }, []);
  return today;
}

import { useEffect, useState } from "react";

import { dayKey, type DayKey } from "../shared/insights.ts";
import { msUntilNextDay } from "./historyView.ts";

/**
 * `read` applied to the local time, re-read when the window comes back and when the local day
 * turns over. `read` should be defined outside the component: a new one re-arms the listeners.
 */
export function useClock<T>(read: (now: Date) => T): T {
  const [value, setValue] = useState(() => read(new Date()));
  useEffect(() => {
    const sync = () => setValue(read(new Date()));
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
  }, [read]);
  return value;
}

/** Today's key. */
export function useToday(): DayKey {
  return useClock(dayKey);
}

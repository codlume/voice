import { useEffect, useState } from "react";

// Outside the component so the purity lint sees the clock read is not part of a render.
const readClock = () => Date.now();

/**
 * The current time, ticking each second only while `active`, so an idle page stays idle. A stale
 * first value is harmless: `recordedMs` counts a leg that started after it as zero until the tick.
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(readClock);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(readClock()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

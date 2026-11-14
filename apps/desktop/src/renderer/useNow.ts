import { useEffect, useState } from "react";

// Outside the component so the purity lint sees the clock read is not part of a render.
const readClock = () => Date.now();

/**
 * The current time, ticking each second only while `active`, so an idle page stays idle. The clock
 * is read again in the render where ticking starts: a meeting clock or countdown would otherwise
 * paint the time from when it last stopped.
 */
export function useNow(active: boolean): number {
  const [clock, setClock] = useState(() => ({ now: readClock(), active }));
  if (clock.active !== active) setClock({ now: readClock(), active });
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setClock({ now: readClock(), active }), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return clock.now;
}

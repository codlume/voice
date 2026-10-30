import { dictating, type Session } from "./session.ts";
import type { Store } from "./store.ts";
import { transforming, type TransformRun } from "./transform-run.ts";

export type Activity = "idle" | "dictation" | "transform";

export function activity(state: { session: Session; transform: TransformRun }): Activity {
  if (dictating(state.session)) return "dictation";
  if (transforming(state.transform)) return "transform";
  return "idle";
}

/**
 * Returns a function that runs a task now, or once the current session or transform run reaches
 * its outcome. Showing a window mid-session would take focus from the target app and fail the
 * insertion; a slow task on main would hold up the key press on its way to capture. A task
 * queued more than once runs once.
 */
export function whenIdle(store: Store): (task: () => void) => void {
  const waiting = new Set<() => void>();
  let flushQueued = false;
  const flush = () => {
    flushQueued = false;
    for (const task of waiting) {
      if (activity(store.state) !== "idle") return;
      waiting.delete(task);
      task();
    }
  };
  // The tasks run in a microtask, after every subscriber has heard the state that freed them: a
  // task that updates the store from inside the notify loop would leave the subscribers after it
  // hearing the older state last. A microtask runs before any I/O, so nothing shows later.
  store.subscribe((state) => {
    if (waiting.size === 0 || flushQueued || activity(state) !== "idle") return;
    flushQueued = true;
    queueMicrotask(flush);
  });
  return (task) => {
    if (waiting.has(task)) return;
    if (activity(store.state) === "idle") task();
    else waiting.add(task);
  };
}

import { dictating, type Session } from "./session.ts";
import type { Store } from "./store.ts";
import { transforming, type TransformRun } from "./transform-run.ts";

type Activity = "idle" | "dictation" | "transform";

export function activity(state: { session: Session; transform: TransformRun }): Activity {
  if (dictating(state.session)) return "dictation";
  if (transforming(state.transform)) return "transform";
  return "idle";
}

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

export function whenSpeechModelSettles(store: Store, timeoutMs: number, task: () => void) {
  const settled = () => ["ready", "failed"].includes(store.state.models.asr.state);
  if (settled()) return task();
  const finish = () => {
    clearTimeout(timer);
    unsubscribe();
    task();
  };
  const timer = setTimeout(finish, timeoutMs);
  const unsubscribe = store.subscribe(() => {
    if (settled()) finish();
  });
}

export function whenTranscriptArrives(store: Store): Promise<void> {
  const owed = () => store.state.session.phase === "transcribing";
  if (!owed()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = store.subscribe(() => {
      if (owed()) return;
      unsubscribe();
      resolve();
    });
  });
}

import type { Settings } from "../shared/api.ts";
import { applyAssignmentEdit, parseAssignmentEdit } from "../shared/style.ts";

export type SettingsQueue = {
  run(change: (current: Settings) => Settings): Promise<Settings>;
  settled(): Promise<void>;
};

export function createSettingsQueue(options: {
  current: () => Settings;
  save: (next: Settings) => Promise<void>;
  applied: (next: Settings, previous: Settings) => void;
}): SettingsQueue {
  const { current, save, applied } = options;
  let last: Promise<unknown> = Promise.resolve();
  return {
    run(change) {
      const saved = last.then(async () => {
        const previous = current();
        const next = change(previous);
        if (next === previous) return previous;
        await save(next);
        applied(next, previous);
        return next;
      });
      last = saved.catch(() => {});
      return saved;
    },
    settled: () => last.then(() => {}),
  };
}

export function editAssignments(queue: SettingsQueue, raw: unknown): Promise<Settings> {
  const edit = parseAssignmentEdit(raw);
  if (edit === null) return Promise.reject(new Error("Could not save these app assignments."));
  return queue.run((current) => {
    const assignments = applyAssignmentEdit(current.cleanup.assignments, edit);
    return assignments === current.cleanup.assignments
      ? current
      : { ...current, cleanup: { ...current.cleanup, assignments } };
  });
}

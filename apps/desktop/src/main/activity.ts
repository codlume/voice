import { dictating, type Session } from "./session.ts";
import { transforming, type TransformRun } from "./transform-run.ts";

export type Activity = "idle" | "dictation" | "transform";

export function activity(state: { session: Session; transform: TransformRun }): Activity {
  if (dictating(state.session)) return "dictation";
  if (transforming(state.transform)) return "transform";
  return "idle";
}

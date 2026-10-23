import { dictating, type Session } from "./session.ts";
import { transforming, type TransformRun } from "./transform-run.ts";

export type Activity = "idle" | "dictation" | "transform";

/**
 * The one derivation of "who is busy". Dictation drops hotkey down and toggle while it is
 * "transform"; transforms drop a shortcut unless it is "idle". A `done` state is not busy: its
 * pill outcome may still show while the next run starts.
 */
export function activity(state: { session: Session; transform: TransformRun }): Activity {
  if (dictating(state.session)) return "dictation";
  if (transforming(state.transform)) return "transform";
  return "idle";
}

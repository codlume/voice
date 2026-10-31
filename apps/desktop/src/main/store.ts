import { toPillSnapshot, type PillSnapshot, type PillState, type Snapshot } from "../shared/api.ts";
import { toPillMeeting, type MeetingFocus } from "./meeting-focus.ts";
import { dictating, toPillState, type Session } from "./session.ts";
import { toPillState as toTransformPillState, type TransformRun } from "./transform-run.ts";

export type AppState = Omit<Snapshot, "session"> & {
  session: Session;
  transform: TransformRun;
  meeting: MeetingFocus;
};

export type Store = {
  readonly state: AppState;
  update(change: (state: AppState) => AppState): void;
  subscribe(listener: (state: AppState, previous: AppState) => void): () => void;
};

function pill(state: AppState): PillState {
  if (dictating(state.session)) return toPillState(state.session);
  return (
    toTransformPillState(state.transform, state.models.transform) ?? toPillState(state.session)
  );
}

export function toSnapshot(state: AppState): Snapshot {
  return {
    microphones: state.microphones,
    microphoneTest: state.microphoneTest,
    updates: state.updates,
    session: pill(state),
    permissions: state.permissions,
    loginItem: state.loginItem,
    models: state.models,
    settings: state.settings,
    account: state.account,
  };
}

export const pillSnapshot = (state: AppState): PillSnapshot =>
  toPillSnapshot(toSnapshot(state), toPillMeeting(state.meeting));

export function createStore(initial: AppState): Store {
  let state = initial;
  const listeners = new Set<(state: AppState, previous: AppState) => void>();
  return {
    get state() {
      return state;
    },
    update(change) {
      const previous = state;
      state = change(previous);
      if (state === previous) return;
      for (const listener of listeners) listener(state, previous);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

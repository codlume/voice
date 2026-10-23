import type { Snapshot } from "../shared/api.ts";
import { toPillState, type Session } from "./session.ts";
import type { TransformRun } from "./transform-run.ts";

export type AppState = Omit<Snapshot, "session"> & { session: Session; transform: TransformRun };

export type Store = {
  readonly state: AppState;
  update(change: (state: AppState) => AppState): void;
  subscribe(listener: (state: AppState, previous: AppState) => void): () => void;
};

// Built field by field, never spread: the transform run must not reach a window.
export function toSnapshot(state: AppState): Snapshot {
  return {
    microphones: state.microphones,
    microphoneTest: state.microphoneTest,
    updates: state.updates,
    session: toPillState(state.session),
    permissions: state.permissions,
    loginItem: state.loginItem,
    models: state.models,
    settings: state.settings,
    account: state.account,
  };
}

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

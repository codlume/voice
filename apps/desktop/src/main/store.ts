import type { Snapshot } from "../shared/api.ts";
import { toPillState, type Session } from "./session.ts";

export type AppState = Omit<Snapshot, "session"> & { session: Session };

export type Store = {
  readonly state: AppState;
  update(change: (state: AppState) => AppState): void;
  subscribe(listener: (state: AppState, previous: AppState) => void): () => void;
};

export function toSnapshot(state: AppState): Snapshot {
  return { ...state, session: toPillState(state.session) };
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

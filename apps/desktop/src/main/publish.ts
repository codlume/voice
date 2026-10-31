import { isDeepStrictEqual } from "node:util";

import { Channel } from "../shared/api.ts";
import { pillSnapshot, toSnapshot, type AppState } from "./store.ts";

type SnapshotTarget = {
  isDestroyed(): boolean;
  readonly webContents: { send(channel: string, value: unknown): void };
};

export function publish(
  { hub, pill }: { hub: SnapshotTarget | undefined; pill: SnapshotTarget },
  state: AppState,
  previous: AppState,
) {
  const snapshot = toSnapshot(state);
  if (hub && !hub.isDestroyed()) hub.webContents.send(Channel.snapshot, snapshot);
  const next = pillSnapshot(state);
  if (pill.isDestroyed() || isDeepStrictEqual(next, pillSnapshot(previous))) return;
  pill.webContents.send(Channel.pillSnapshot, next);
}

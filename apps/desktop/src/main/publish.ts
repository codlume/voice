import { isDeepStrictEqual } from "node:util";

import { Channel, toPillSnapshot } from "../shared/api.ts";
import { toSnapshot, type AppState } from "./store.ts";

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
  const pillSnapshot = toPillSnapshot(snapshot);
  if (pill.isDestroyed() || isDeepStrictEqual(pillSnapshot, toPillSnapshot(toSnapshot(previous))))
    return;
  pill.webContents.send(Channel.pillSnapshot, pillSnapshot);
}

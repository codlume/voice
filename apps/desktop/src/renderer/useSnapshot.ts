import { useEffect, useState } from "react";

import type { PillSnapshot, Snapshot } from "../shared/api.ts";
import { hubApi, pillApi } from "./voice.ts";

export function useSnapshot(): Snapshot | null {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => {
    void hubApi().getSnapshot().then(setSnapshot);
    return hubApi().onSnapshot(setSnapshot);
  }, []);
  return snapshot;
}

export function usePillSnapshot(): PillSnapshot | null {
  const [snapshot, setSnapshot] = useState<PillSnapshot | null>(null);
  useEffect(() => {
    void pillApi().getPillSnapshot().then(setSnapshot);
    return pillApi().onPillSnapshot(setSnapshot);
  }, []);
  return snapshot;
}

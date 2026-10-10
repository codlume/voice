import { useEffect, useState } from "react";

import type { PillSnapshot, Snapshot } from "../shared/api.ts";

export function useSnapshot(): Snapshot | null {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => {
    void window.voice.getSnapshot().then(setSnapshot);
    return window.voice.onSnapshot(setSnapshot);
  }, []);
  return snapshot;
}

export function usePillSnapshot(): PillSnapshot | null {
  const [snapshot, setSnapshot] = useState<PillSnapshot | null>(null);
  useEffect(() => {
    void window.voice.getPillSnapshot().then(setSnapshot);
    return window.voice.onPillSnapshot(setSnapshot);
  }, []);
  return snapshot;
}

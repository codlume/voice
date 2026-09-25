import { useEffect, useState } from "react";

import type { Snapshot } from "../shared/api.ts";

export function useSnapshot(): Snapshot | null {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => {
    void window.voice.getSnapshot().then(setSnapshot);
    return window.voice.onSnapshot(setSnapshot);
  }, []);
  return snapshot;
}

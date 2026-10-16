import { useEffect, useState } from "react";

import type { InstalledApp } from "../shared/api.ts";
import { hubApi } from "./voice.ts";

export function useInstalledApps(): readonly InstalledApp[] {
  const [apps, setApps] = useState<readonly InstalledApp[]>([]);
  useEffect(() => {
    let mounted = true;
    hubApi()
      .getInstalledApps()
      .catch((): InstalledApp[] => [])
      .then((next) => {
        if (mounted) setApps(next);
      });
    return () => {
      mounted = false;
    };
  }, []);
  return apps;
}

import { useEffect, useState } from "react";

import type { InstalledApp } from "../shared/api.ts";
import { listInstalledApps } from "./appIcons.ts";

export function useInstalledApps(): readonly InstalledApp[] {
  const [apps, setApps] = useState<readonly InstalledApp[]>([]);
  useEffect(() => {
    let mounted = true;
    listInstalledApps().then(
      (next) => {
        if (mounted) setApps(next);
      },
      () => {},
    );
    return () => {
      mounted = false;
    };
  }, []);
  return apps;
}

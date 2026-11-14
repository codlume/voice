import { useEffect, useState } from "react";

import type { InstalledApp } from "../shared/api.ts";
import { listInstalledApps } from "./appIcons.ts";

export type InstalledApps = { apps: readonly InstalledApp[]; failed: boolean };

export function useInstalledApps(): InstalledApps {
  const [installed, setInstalled] = useState<InstalledApps>({ apps: [], failed: false });
  useEffect(() => {
    let mounted = true;
    listInstalledApps().then(
      (apps) => {
        if (mounted) setInstalled({ apps, failed: false });
      },
      () => {
        if (mounted) setInstalled({ apps: [], failed: true });
      },
    );
    return () => {
      mounted = false;
    };
  }, []);
  return installed;
}

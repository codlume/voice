import * as stylex from "@stylexjs/stylex";
import { useEffect, useState, useSyncExternalStore } from "react";

import type { BundleId } from "../shared/app-categories.ts";
import { iconLoader } from "./appIcons.ts";
import { color } from "./tokens.stylex.ts";

export function useAppIcon(bundleId: BundleId): string | null {
  useEffect(() => {
    const load = () => void iconLoader.load(bundleId);
    load();
    return iconLoader.subscribe(load);
  }, [bundleId]);
  return useSyncExternalStore(iconLoader.subscribe, () => iconLoader.get(bundleId));
}

const styles = stylex.create({
  image: { display: "block", width: 24, height: 24 },
  // macOS icons leave a margin inside their canvas, so a letter tile is drawn smaller to match.
  monogram: {
    display: "grid",
    placeItems: "center",
    width: 20,
    height: 20,
    borderRadius: 5,
    backgroundColor: color.segmentTrack,
    color: color.mutedForeground,
    fontSize: 11,
    fontWeight: 600,
  },
});

export function AppIcon({ bundleId, name }: { bundleId: BundleId; name: string }) {
  const icon = useAppIcon(bundleId);
  const [failed, setFailed] = useState<string | null>(null);
  if (icon !== null && icon !== failed) {
    return (
      <img
        src={icon}
        alt={name}
        draggable={false}
        onError={() => setFailed(icon)}
        {...stylex.props(styles.image)}
      />
    );
  }
  return (
    <span role="img" aria-label={name} {...stylex.props(styles.monogram)}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

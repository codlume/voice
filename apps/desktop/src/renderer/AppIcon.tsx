import * as stylex from "@stylexjs/stylex";
import { useEffect, useState, useSyncExternalStore } from "react";

import type { BundleId } from "../shared/app-categories.ts";
import { iconLoader } from "./appIcons.ts";
import { color } from "./tokens.stylex.ts";

function useAppIcon(bundleId: BundleId | null): string | null {
  useEffect(() => {
    if (bundleId === null) return;
    const load = () => void iconLoader.load(bundleId);
    load();
    return iconLoader.subscribe(load);
  }, [bundleId]);
  return useSyncExternalStore(iconLoader.subscribe, () =>
    bundleId === null ? null : iconLoader.get(bundleId),
  );
}

const styles = stylex.create({
  image: { display: "block" },
  image24: { width: 24, height: 24 },
  image20: { width: 20, height: 20 },
  image16: { width: 16, height: 16 },
  monogram: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    backgroundColor: color.segmentTrack,
    color: color.mutedForeground,
    fontWeight: 600,
  },
  // macOS icons leave a margin inside their canvas, so a letter tile is drawn smaller to match.
  monogram24: { width: 20, height: 20, margin: 2, borderRadius: 5, fontSize: 11 },
  monogram20: { width: 17, height: 17, margin: 1.5, borderRadius: 4, fontSize: 10 },
  monogram16: { width: 14, height: 14, margin: 1, borderRadius: 3.5, fontSize: 9 },
});

const sizes = {
  24: [styles.image24, styles.monogram24],
  20: [styles.image20, styles.monogram20],
  16: [styles.image16, styles.monogram16],
} as const;

export function AppIcon({
  bundleId,
  name,
  size = 24,
  decorative = false,
}: {
  bundleId: BundleId | null;
  name: string;
  size?: keyof typeof sizes;
  decorative?: boolean;
}) {
  const icon = useAppIcon(bundleId);
  const [failed, setFailed] = useState<string | null>(null);
  const [image, monogram] = sizes[size];
  if (icon !== null && icon !== failed) {
    return (
      <img
        src={icon}
        alt={decorative ? "" : name}
        draggable={false}
        onError={() => setFailed(icon)}
        {...stylex.props(styles.image, image)}
      />
    );
  }
  return (
    <span
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": name })}
      {...stylex.props(styles.monogram, monogram)}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

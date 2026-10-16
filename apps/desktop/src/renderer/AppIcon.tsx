import * as stylex from "@stylexjs/stylex";
import { useEffect, useReducer, useState } from "react";

import type { BundleId } from "../shared/app-categories.ts";
import { createIconLoader } from "./appIcons.ts";
import { color } from "./tokens.stylex.ts";
import { hubApi } from "./voice.ts";

const loader = createIconLoader((bundleIds) => hubApi().getAppIcons(bundleIds));

export function useAppIcon(bundleId: BundleId): string | null {
  const [, arrived] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (loader.get(bundleId) !== null) return;
    let mounted = true;
    void loader.load(bundleId).then((icon) => {
      if (mounted && icon !== null) arrived();
    });
    return () => {
      mounted = false;
    };
  }, [bundleId]);
  return loader.get(bundleId);
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

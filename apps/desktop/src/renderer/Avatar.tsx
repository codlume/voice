import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import type { AccountIdentity } from "../shared/api.ts";
import { initials } from "./accountView.ts";
import { color, radius } from "./tokens.stylex.ts";

const spin = stylex.keyframes({ to: { transform: "rotate(360deg)" } });

const styles = stylex.create({
  circle: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    overflow: "hidden",
    borderRadius: radius.round,
    backgroundColor: `color-mix(in srgb, ${color.primary} 14%, transparent)`,
    color: color.primary,
    fontWeight: 600,
    letterSpacing: "0.02em",
  },
  size: (size: number) => ({ width: size, height: size, fontSize: size * 0.375 }),
  picture: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  waiting: {
    width: "40%",
    height: "40%",
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: `color-mix(in srgb, ${color.primary} 25%, transparent)`,
    borderTopColor: color.primary,
    borderRadius: radius.round,
    animationName: { default: spin, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "1.2s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
});

// The initials stay underneath, so they show while the picture loads.
export function Avatar({ identity, size }: { identity: AccountIdentity; size: number }) {
  const { name, image } = identity;
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span aria-hidden="true" {...stylex.props(styles.circle, styles.size(size))}>
      {initials(name)}
      {image && image !== failed && (
        <img
          src={image}
          alt=""
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => setFailed(image)}
          {...stylex.props(styles.picture)}
        />
      )}
    </span>
  );
}

export function AvatarSpinner({ size }: { size: number }) {
  return (
    <span aria-hidden="true" {...stylex.props(styles.circle, styles.size(size))}>
      <span {...stylex.props(styles.waiting)} />
    </span>
  );
}

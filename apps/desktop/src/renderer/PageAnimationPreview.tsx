import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { pageMotion } from "./pageMotion.ts";
import { color, radius } from "./tokens.stylex.ts";

const reducedMotion = "@media (prefers-reduced-motion: reduce)";
const easing = "cubic-bezier(0.2, 0, 0, 1)";

const styles = stylex.create({
  window: {
    display: "flex",
    gap: 4,
    width: "100%",
    height: 40,
    padding: 4,
    overflow: "hidden",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.medium,
    backgroundColor: color.background,
    cursor: "pointer",
  },
  sidebar: {
    flexShrink: 0,
    width: 16,
    height: "100%",
    borderRadius: 4,
    backgroundColor: color.sidebar,
    transitionProperty: "width",
    transitionDuration: { default: "var(--page-animation)", [reducedMotion]: "0s" },
    transitionTimingFunction: easing,
  },
  sidebarCollapsed: { width: 6 },
  content: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    gap: 4,
    minWidth: 0,
    paddingTop: 4,
    paddingInline: 4,
  },
  line: (width: string) => ({
    width,
    height: 2,
    borderRadius: radius.round,
    backgroundColor: `color-mix(in srgb, ${color.mutedForeground} 25%, transparent)`,
  }),
});

export function PageAnimationPreview() {
  const [plays, setPlays] = useState(0);
  return (
    <button
      type="button"
      aria-label="Replay page animation preview"
      onClick={() => setPlays(plays + 1)}
      {...stylex.props(styles.window)}
    >
      <span
        aria-hidden
        {...stylex.props(styles.sidebar, plays % 2 === 1 && styles.sidebarCollapsed)}
      />
      <span key={plays} aria-hidden {...stylex.props(styles.content, plays > 0 && pageMotion.rise)}>
        {["100%", "80%", "60%"].map((width) => (
          <span key={width} {...stylex.props(styles.line(width))} />
        ))}
      </span>
    </button>
  );
}

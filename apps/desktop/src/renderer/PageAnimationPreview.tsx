import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { pageMotion } from "./pageMotion.ts";
import { color, motion, radius, space } from "./tokens.stylex.ts";

const styles = stylex.create({
  window: {
    display: "flex",
    gap: space.xxs,
    width: "100%",
    height: 40,
    padding: space.xxs,
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
    borderRadius: radius.xs,
    backgroundColor: color.sidebar,
    transitionProperty: "width",
    transitionDuration: { default: "var(--page-animation)", [motion.reduced]: "0s" },
    transitionTimingFunction: motion.drawer,
  },
  sidebarCollapsed: { width: 6 },
  content: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    gap: space.xxs,
    minWidth: 0,
    paddingTop: space.xxs,
    paddingInline: space.xxs,
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

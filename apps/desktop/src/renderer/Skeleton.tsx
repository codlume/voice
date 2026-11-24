import { Progress } from "@base-ui/react/progress";
import * as stylex from "@stylexjs/stylex";

import { color, motion, radius } from "./tokens.stylex.ts";

// Adapted skeleton (MIT, see THIRD_PARTY_NOTICES.md). The breath is stepped, so the compositor
// draws a few frames per cycle instead of one per refresh.
const breathe = stylex.keyframes({
  "0%, 42%": { opacity: 1, animationTimingFunction: "steps(4)" },
  "50%, 92%": { opacity: 0.55, animationTimingFunction: "steps(4)" },
  "100%": { opacity: 1 },
});

const styles = stylex.create({
  skeleton: {
    display: "block",
    backgroundColor: `color-mix(in srgb, ${color.mutedForeground} 15%, transparent)`,
    animationName: { default: breathe, [motion.reduced]: "none" },
    animationDuration: "2.4s",
    animationIterationCount: "infinite",
  },
  block: { borderRadius: radius.xs },
  card: { borderRadius: radius.medium },
  pill: { borderRadius: radius.round },
  size: (width: string, height: string) => ({ width, height }),
  track: {
    position: "relative",
    width: "100%",
    height: 4,
    overflow: "hidden",
    borderRadius: radius.round,
    backgroundColor: color.input,
  },
  indicator: {
    display: "block",
    height: "100%",
    borderRadius: radius.round,
    backgroundColor: color.primary,
    transitionProperty: "width",
    transitionDuration: { default: motion.slow, [motion.reduced]: "0s" },
    transitionTimingFunction: motion.ease,
  },
});

/** A placeholder bar for content that is still loading. Hidden from assistive tech. */
export function Skeleton({
  shape = "block",
  width = "100%",
  height = "16px",
}: {
  shape?: "block" | "card" | "pill";
  width?: string;
  height?: string;
}) {
  return (
    <span
      aria-hidden
      {...stylex.props(styles.skeleton, styles[shape], styles.size(width, height))}
    />
  );
}

/** Determinate progress from 0 to 100. Name it with `label`. */
export function ProgressBar({ value, label }: { value: number; label: string }) {
  return (
    <Progress.Root value={value} aria-label={label}>
      <Progress.Track {...stylex.props(styles.track)}>
        <Progress.Indicator {...stylex.props(styles.indicator)} />
      </Progress.Track>
    </Progress.Root>
  );
}

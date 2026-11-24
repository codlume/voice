import * as stylex from "@stylexjs/stylex";

import { motion } from "./tokens.stylex.ts";

const rise = stylex.keyframes({ from: { opacity: 0, transform: "translateY(8px)" } });

export const pageMotion = stylex.create({
  rise: {
    animationName: { default: rise, [motion.reduced]: "none" },
    animationDuration: "var(--page-animation)",
    animationTimingFunction: motion.easeOut,
  },
});

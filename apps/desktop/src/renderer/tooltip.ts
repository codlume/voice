import * as stylex from "@stylexjs/stylex";

import { color, font, radius, space } from "./tokens.stylex.ts";

const reducedMotion = "@media (prefers-reduced-motion: reduce)";

const easing = "cubic-bezier(0.2, 0, 0, 1)";

export const tooltip = stylex.create({
  positioner: { zIndex: 10 },
  popup: {
    whiteSpace: "nowrap",
    paddingBlock: 5,
    paddingInline: space.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.small,
    backgroundColor: color.card,
    color: color.foreground,
    boxShadow: "0 2px 8px rgb(0 0 0 / 12%)",
    fontFamily: font.sans,
    fontSize: 12,
    lineHeight: 1.4,
    WebkitFontSmoothing: "antialiased",
    opacity: 1,
    transitionProperty: "opacity",
    transitionDuration: { default: "180ms", [reducedMotion]: "0s" },
    transitionTimingFunction: easing,
  },
  hidden: { opacity: 0 },
  instant: { transitionDuration: "0s" },
});

import * as stylex from "@stylexjs/stylex";

import { color, elevation, font, leading, motion, radius, space, text } from "./tokens.stylex.ts";

// Adapted tooltip (MIT, see THIRD_PARTY_NOTICES.md): small, bordered, scaling from its anchor.
const tooltip = stylex.create({
  positioner: { zIndex: 10 },
  popup: {
    whiteSpace: "nowrap",
    paddingBlock: space.xxs,
    paddingInline: space.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.small,
    backgroundColor: color.popover,
    color: color.foreground,
    boxShadow: elevation.md,
    fontFamily: font.sans,
    fontSize: text.xs,
    lineHeight: leading.xs,
    WebkitFontSmoothing: "antialiased",
    opacity: 1,
    transformOrigin: "var(--transform-origin)",
    transitionProperty: "opacity, scale",
    transitionDuration: { default: motion.base, [motion.reduced]: "0s" },
    transitionTimingFunction: motion.ease,
  },
  hidden: { opacity: 0, scale: 0.98 },
  instant: { transitionDuration: "0s" },
});

type TooltipState = { transitionStatus?: string | undefined; instant?: string | undefined };

const isInstant = ({ instant }: TooltipState) => instant === "focus" || instant === "dismiss";

export const tooltipPositionerClass =
  (...extra: stylex.StyleXStyles[]) =>
  (state: TooltipState) =>
    stylex.props(tooltip.positioner, ...extra, isInstant(state) && tooltip.instant).className;

export const tooltipPopupClass =
  (...extra: stylex.StyleXStyles[]) =>
  (state: TooltipState) =>
    stylex.props(
      tooltip.popup,
      ...extra,
      (state.transitionStatus === "starting" || state.transitionStatus === "ending") &&
        tooltip.hidden,
      isInstant(state) && tooltip.instant,
    ).className;

import * as stylex from "@stylexjs/stylex";

import { blur, color, elevation, font, leading, motion, radius, text } from "./tokens.stylex.ts";

// Shared surfaces, adapted under MIT (see THIRD_PARTY_NOTICES.md).
export const surfaces = stylex.create({
  // A bordered control: outline buttons, select triggers and text fields.
  control: {
    position: "relative",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.input,
    borderRadius: radius.medium,
    backgroundColor: { default: color.control, ":hover": color.controlHover },
    color: color.foreground,
    boxShadow: elevation.xs,
    "::before": {
      content: "''",
      position: "absolute",
      inset: 0,
      borderRadius: `calc(${radius.medium} - 1px)`,
      boxShadow: elevation.edge,
      pointerEvents: "none",
    },
  },
  // A text field shows focus as a ring around its border instead of the global outline.
  field: {
    outline: "none",
    transitionProperty: "box-shadow, border-color",
    transitionDuration: motion.base,
    borderColor: { default: color.input, ":focus-within": color["--ring"] },
    boxShadow: {
      default: elevation.xs,
      ":focus-within": `0 0 0 3px color-mix(in srgb, ${color["--ring"]} 24%, transparent)`,
    },
  },
  fieldInvalid: {
    borderColor: {
      default: `color-mix(in srgb, ${color.error} 36%, transparent)`,
      ":focus-within": `color-mix(in srgb, ${color.error} 64%, transparent)`,
    },
    boxShadow: {
      default: elevation.xs,
      ":focus-within": `0 0 0 3px color-mix(in srgb, ${color.error} 16%, transparent)`,
    },
  },
  // Menus, select lists and popovers: frosted glass with a soft drop shadow.
  popup: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.glassBorder,
    borderRadius: radius.medium,
    backgroundColor: color.dropdownGlass,
    backdropFilter: { default: blur.glass, [motion.dark]: blur.glassDark },
    boxShadow: elevation.popup,
    color: color.foreground,
    fontFamily: font.sans,
    fontSize: text.sm,
    lineHeight: leading.sm,
    WebkitFontSmoothing: "antialiased",
    outline: "none",
    transformOrigin: "var(--transform-origin)",
  },
  // Popovers and tooltips grow from their anchor; menus open instantly.
  popupMotion: {
    transitionProperty: "opacity, scale",
    transitionDuration: motion.base,
    transitionTimingFunction: motion.ease,
  },
  popupHidden: { opacity: 0, scale: 0.98 },
  // One row of a menu or select list.
  item: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    minHeight: 28,
    paddingBlock: 4,
    paddingInline: 8,
    borderRadius: radius.xs,
    color: color.foreground,
    cursor: "pointer",
    userSelect: "none",
    outline: "none",
  },
  itemHighlighted: { backgroundColor: color.accent },
  itemDisabled: { opacity: 0.64, cursor: "not-allowed" },
  separator: { height: 1, marginBlock: 4, marginInline: 8, backgroundColor: color.border },
  groupLabel: {
    paddingBlock: 6,
    paddingInline: 8,
    color: color.mutedForeground,
    fontSize: text.xs,
    lineHeight: leading.xs,
    fontWeight: 500,
  },
  // Dialogs: a larger frosted panel.
  dialog: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.glassBorder,
    borderRadius: radius.xl,
    backgroundColor: color.glass,
    backdropFilter: { default: blur.glass, [motion.dark]: blur.glassDark },
    boxShadow: elevation.dialog,
    color: color.foreground,
    fontFamily: font.sans,
    WebkitFontSmoothing: "antialiased",
    outline: "none",
  },
  backdrop: {
    position: "fixed",
    inset: 0,
    backgroundColor: color.backdrop,
    backdropFilter: blur.backdrop,
  },
});

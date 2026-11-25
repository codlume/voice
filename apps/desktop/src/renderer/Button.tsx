import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import { surfaces } from "./surfaces.ts";
import { color, elevation, font, leading, motion, radius, text } from "./tokens.stylex.ts";

// Adapted button (MIT, see THIRD_PARTY_NOTICES.md): 32px controls, a press scale, and a lit top
// edge on filled buttons that flips to a shade while pressed.
const styles = stylex.create({
  button: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    flexShrink: 0,
    height: 32,
    paddingBlock: 0,
    paddingInline: 11,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: radius.medium,
    fontFamily: font.sans,
    fontSize: text.sm,
    fontWeight: 500,
    lineHeight: leading.sm,
    whiteSpace: "nowrap",
    cursor: { default: "pointer", ":disabled": "default" },
    opacity: { default: 1, ":disabled": 0.64 },
    pointerEvents: { default: null, ":disabled": "none" },
    transform: { default: null, ":active": "scale(0.97)" },
    transitionProperty: "box-shadow, transform, background-color",
    transitionDuration: { default: motion.base, [motion.reduced]: "0s" },
    transitionTimingFunction: motion.ease,
  },
  primary: {
    borderColor: color.primary,
    backgroundColor: {
      default: color.primary,
      ":hover": `color-mix(in srgb, ${color.primary} 90%, transparent)`,
    },
    color: color.primaryForeground,
    boxShadow: {
      default: `${elevation.highlight}, ${elevation.primary}`,
      ":active": elevation.pressed,
      ":disabled": "none",
    },
  },
  destructive: {
    borderColor: color.error,
    backgroundColor: {
      default: color.error,
      ":hover": `color-mix(in srgb, ${color.error} 90%, transparent)`,
    },
    color: "white",
    boxShadow: {
      default: `${elevation.highlight}, 0 1px 2px 0 color-mix(in srgb, ${color.error} 24%, transparent)`,
      ":active": elevation.pressed,
      ":disabled": "none",
    },
  },
  // Muted inline text that brightens on hover.
  text: {
    height: "auto",
    paddingInline: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: { default: color.mutedForeground, ":hover": color.foreground },
    fontSize: text.xs,
    lineHeight: leading.xs,
    textDecoration: { default: "none", ":hover": "underline" },
    textUnderlineOffset: 2,
    transform: "none",
  },
  // A destructive action placed beside other actions: red text with no fill until hovered.
  ghostDestructive: {
    backgroundColor: { default: "transparent", ":hover": color.errorSurface },
    color: color.errorForeground,
  },
  icon: {
    width: 28,
    height: 28,
    paddingInline: 0,
    backgroundColor: { default: "transparent", ":hover": color.accent },
    color: { default: color.mutedForeground, ":hover": color.foreground },
  },
  pressed: { backgroundColor: color.accent, color: color.foreground },
});

export function Button({
  variant = "primary",
  pressed,
  ...props
}: Omit<ComponentProps<"button">, "type" | "className" | "style" | "aria-pressed"> & {
  variant?: "primary" | "secondary" | "destructive" | "ghostDestructive" | "text" | "icon";
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      {...props}
      {...stylex.props(
        styles.button,
        variant === "secondary" ? surfaces.control : styles[variant],
        pressed && styles.pressed,
      )}
    />
  );
}

import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import { color, radius } from "./tokens.stylex.ts";

const styles = stylex.create({
  button: {
    flexShrink: 0,
    paddingBlock: 6,
    paddingInline: 14,
    borderRadius: radius.round,
    font: "inherit",
    fontSize: 13,
    cursor: { default: "pointer", ":disabled": "default" },
    opacity: { default: 1, ":disabled": 0.45 },
  },
  primary: {
    minWidth: 76,
    borderWidth: 0,
    backgroundColor: {
      default: color.primary,
      ":hover": `color-mix(in srgb, ${color.primary} 90%, transparent)`,
    },
    color: color.primaryForeground,
    fontWeight: 500,
  },
  destructive: {
    minWidth: 76,
    borderWidth: 0,
    backgroundColor: {
      default: color.error,
      ":hover": `color-mix(in srgb, ${color.error} 90%, transparent)`,
    },
    color: color.primaryForeground,
    fontWeight: 500,
  },
  secondary: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    backgroundColor: { default: color.card, ":hover": color.accent },
    color: color.foreground,
  },
});

export function Button({
  variant = "primary",
  ...props
}: Omit<ComponentProps<"button">, "type" | "className" | "style"> & {
  variant?: "primary" | "secondary" | "destructive";
}) {
  return <button type="button" {...props} {...stylex.props(styles.button, styles[variant])} />;
}

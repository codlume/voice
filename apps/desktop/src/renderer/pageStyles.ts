import * as stylex from "@stylexjs/stylex";

import { color, leading, text } from "./tokens.stylex.ts";

export const pageStyles = stylex.create({
  headline: {
    margin: 0,
    fontSize: text.xxl,
    fontWeight: 600,
    lineHeight: leading.xxl,
    letterSpacing: "-0.015em",
  },
  error: { margin: 0, color: color.errorForeground, fontSize: text.xs, lineHeight: leading.xs },
});

import * as stylex from "@stylexjs/stylex";

import { color, font } from "./tokens.stylex.ts";

export const pageStyles = stylex.create({
  headline: {
    margin: 0,
    fontFamily: font.serif,
    fontSize: 36,
    fontWeight: 400,
    lineHeight: 1.15,
    letterSpacing: "-0.01em",
  },
  error: { margin: 0, color: color.errorForeground, fontSize: 12.5 },
});

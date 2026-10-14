import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { color, radius } from "./tokens.stylex.ts";

const styles = stylex.create({
  card: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.large,
    backgroundColor: color.card,
  },
});

export function Card({ style, children }: { style?: stylex.StyleXStyles; children: ReactNode }) {
  return <div {...stylex.props(styles.card, style)}>{children}</div>;
}

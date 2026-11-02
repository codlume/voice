import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import type { HelpAnchor } from "./help.ts";
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

export function Card({
  style,
  help,
  children,
}: {
  style?: stylex.StyleXStyles;
  help?: HelpAnchor;
  children: ReactNode;
}) {
  return (
    <div data-help={help} {...stylex.props(styles.card, style)}>
      {children}
    </div>
  );
}

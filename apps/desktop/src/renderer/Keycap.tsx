import * as stylex from "@stylexjs/stylex";

import { color, font, radius } from "./tokens.stylex.ts";

const styles = stylex.create({
  keycap: {
    display: "inline-block",
    minWidth: 22,
    paddingInline: 6,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.foreground,
    borderRadius: radius.small,
    backgroundColor: color.card,
    boxShadow: `-1px 1px 0 0 ${color.foreground}`,
    color: color.foreground,
    fontFamily: font.sans,
    fontSize: 12,
    fontWeight: 500,
    fontVariantNumeric: "tabular-nums",
    lineHeight: "18px",
    textAlign: "center",
    whiteSpace: "nowrap",
    verticalAlign: "0.1em",
  },
});

export function Keycap({ children }: { children: string }) {
  return <kbd {...stylex.props(styles.keycap)}>{children}</kbd>;
}

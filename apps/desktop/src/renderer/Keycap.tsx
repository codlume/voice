import * as stylex from "@stylexjs/stylex";

import { color, font, radius } from "./tokens.stylex.ts";

const styles = stylex.create({
  keycap: {
    display: "inline-block",
    minWidth: 22,
    paddingInline: 6,
    borderRadius: radius.small,
    backgroundColor: `color-mix(in srgb, ${color.foreground} 8%, transparent)`,
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

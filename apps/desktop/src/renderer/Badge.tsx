import * as stylex from "@stylexjs/stylex";

import { color, radius } from "./tokens.stylex.ts";

const styles = stylex.create({
  badge: {
    display: "inline-block",
    flexShrink: 0,
    paddingInline: 6,
    borderRadius: radius.round,
    backgroundColor: `color-mix(in srgb, ${color.foreground} 6%, transparent)`,
    color: `color-mix(in srgb, ${color.foreground} 30%, ${color.mutedForeground})`,
    fontSize: 11,
    fontWeight: 500,
    lineHeight: "16px",
    whiteSpace: "nowrap",
  },
});

export function Badge({ children }: { children: string }) {
  return <span {...stylex.props(styles.badge)}>{children}</span>;
}

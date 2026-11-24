import * as stylex from "@stylexjs/stylex";

import { color, leading, radius, text } from "./tokens.stylex.ts";

const styles = stylex.create({
  // Adapted secondary badge (MIT, see THIRD_PARTY_NOTICES.md).
  badge: {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    height: 18,
    paddingInline: 3,
    borderRadius: radius.xs,
    backgroundColor: color.secondary,
    color: color.mutedForeground,
    fontSize: text.xs,
    fontWeight: 500,
    lineHeight: leading.xs,
    whiteSpace: "nowrap",
  },
});

export function Badge({ children }: { children: string }) {
  return <span {...stylex.props(styles.badge)}>{children}</span>;
}

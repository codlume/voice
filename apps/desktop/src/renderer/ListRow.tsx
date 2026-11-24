import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { color, leading, motion, radius, space, text } from "./tokens.stylex.ts";

// Adapted list row (MIT, see THIRD_PARTY_NOTICES.md): a rounded row that tints on hover, with a
// medium title, a muted detail line and trailing controls.
const styles = stylex.create({
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    minHeight: 32,
    paddingBlock: space.xs,
    paddingInline: space.sm,
    borderRadius: radius.medium,
    backgroundColor: { default: "transparent", ":hover": color.accent },
    transitionProperty: "background-color",
    transitionDuration: { default: motion.base, [motion.reduced]: "0s" },
  },
  leading: { display: "flex", flexShrink: 0, color: color.mutedForeground },
  text: { flexGrow: 1, minWidth: 0 },
  title: {
    display: "block",
    overflow: "hidden",
    color: color.foreground,
    fontSize: text.sm,
    fontWeight: 500,
    lineHeight: leading.sm,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  detail: {
    display: "block",
    overflow: "hidden",
    color: color.mutedForeground,
    fontSize: text.xs,
    lineHeight: leading.xs,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  trailing: { display: "flex", flexShrink: 0, alignItems: "center", gap: space.xxs },
});

export function ListRow({
  title,
  detail,
  leading: start,
  trailing,
}: {
  title: ReactNode;
  detail?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.row)}>
      {start && <span {...stylex.props(styles.leading)}>{start}</span>}
      <span {...stylex.props(styles.text)}>
        <span {...stylex.props(styles.title)}>{title}</span>
        {detail && <span {...stylex.props(styles.detail)}>{detail}</span>}
      </span>
      {trailing && <span {...stylex.props(styles.trailing)}>{trailing}</span>}
    </div>
  );
}

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { color, elevation, leading, radius, space, text } from "./tokens.stylex.ts";

// Adapted empty state (MIT, see THIRD_PARTY_NOTICES.md): an icon tile fanned over two tilted
// copies, a title, a muted line and optional actions, centered.
const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.base,
    minHeight: 256,
    padding: 24,
    textAlign: "center",
    textWrap: "balance",
  },
  media: { position: "relative", display: "flex" },
  tile: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: 36,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.small,
    backgroundColor: color.card,
    color: color.foreground,
    boxShadow: elevation.sm,
  },
  copy: { position: "absolute", bottom: 1, boxShadow: "none", scale: 0.84, pointerEvents: "none" },
  copyLeft: { transformOrigin: "bottom left", translate: "-2px 0", rotate: "-10deg" },
  copyRight: { transformOrigin: "bottom right", translate: "2px 0", rotate: "10deg" },
  text: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.xxs,
    maxWidth: 384,
  },
  title: { margin: 0, fontSize: text.xl, fontWeight: 600, lineHeight: leading.xl },
  description: {
    margin: 0,
    color: color.mutedForeground,
    fontSize: text.sm,
    lineHeight: leading.sm,
  },
  actions: { display: "flex", flexWrap: "wrap", justifyContent: "center", gap: space.sm },
});

export function EmptyState({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.root)}>
      <div aria-hidden {...stylex.props(styles.media)}>
        <span {...stylex.props(styles.tile, styles.copy, styles.copyLeft)} />
        <span {...stylex.props(styles.tile, styles.copy, styles.copyRight)} />
        <span {...stylex.props(styles.tile)}>{icon}</span>
      </div>
      <div {...stylex.props(styles.text)}>
        <h2 {...stylex.props(styles.title)}>{title}</h2>
        {description && <p {...stylex.props(styles.description)}>{description}</p>}
      </div>
      {children && <div {...stylex.props(styles.actions)}>{children}</div>}
    </div>
  );
}

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
  keys: { display: "flex", flexShrink: 0, gap: 4, fontFamily: "inherit" },
  none: { flexShrink: 0, color: color.mutedForeground, fontSize: 12 },
});

export function Keycap({ children }: { children: string }) {
  return <kbd {...stylex.props(styles.keycap)}>{children}</kbd>;
}

export function Keys({ keys }: { keys: readonly string[] | null }) {
  if (keys === null) return <span {...stylex.props(styles.none)}>No shortcut</span>;
  return (
    <kbd {...stylex.props(styles.keys)}>
      {keys.map((key) => (
        <Keycap key={key}>{key}</Keycap>
      ))}
    </kbd>
  );
}

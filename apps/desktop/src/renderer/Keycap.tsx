import * as stylex from "@stylexjs/stylex";

import { color, font, leading, radius, text } from "./tokens.stylex.ts";

const styles = stylex.create({
  // Adapted kbd (MIT, see THIRD_PARTY_NOTICES.md).
  keycap: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 20,
    height: 20,
    paddingInline: 4,
    borderRadius: radius.xs,
    backgroundColor: `color-mix(in srgb, ${color.foreground} 7%, transparent)`,
    color: color.mutedForeground,
    fontFamily: font.sans,
    fontSize: text.xs,
    fontWeight: 500,
    fontVariantNumeric: "tabular-nums",
    lineHeight: leading.xs,
    whiteSpace: "nowrap",
    verticalAlign: "middle",
  },
  keys: { display: "flex", flexShrink: 0, gap: 4, fontFamily: "inherit" },
  none: { flexShrink: 0, color: color.mutedForeground, fontSize: text.xs },
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

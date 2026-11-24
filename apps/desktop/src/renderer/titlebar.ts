import * as stylex from "@stylexjs/stylex";

import { color, radius } from "./tokens.stylex.ts";

export const titlebar = stylex.create({
  button: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    width: 28,
    height: 28,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.medium,
    backgroundColor: { default: "transparent", ":hover": color.accent },
    color: { default: color.mutedForeground, ":hover": color.foreground },
    cursor: "pointer",
    WebkitAppRegion: "no-drag",
  },
});

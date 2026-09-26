import * as stylex from "@stylexjs/stylex";

import { color, font, radius, space } from "./tokens.stylex.ts";

export const styles = stylex.create({
  body: {
    display: "flex",
    flexDirection: "column",
    minHeight: "100vh",
    paddingBlock: space.xl,
    paddingInline: space.xl,
    backgroundColor: color.page,
    color: color.ink,
    fontFamily: font.sans,
    fontSize: 15,
    lineHeight: 1.5,
    WebkitFontSmoothing: "antialiased",
  },
  brand: {
    margin: 0,
    fontFamily: font.serif,
    fontSize: 20,
    fontWeight: 500,
  },
  main: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space.xl,
    width: "100%",
    maxWidth: 560,
    marginBlock: "auto",
    marginInline: "auto",
    paddingBlock: space.xxl,
  },
  headline: {
    margin: 0,
    fontFamily: font.serif,
    fontSize: { default: 48, "@media (max-width: 480px)": 36 },
    fontWeight: 400,
    lineHeight: 1.1,
    letterSpacing: "-0.01em",
  },
  lede: { margin: 0, marginTop: space.md, color: color.muted, fontSize: 17 },
  download: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: space.sm },
  primary: {
    display: "inline-block",
    paddingBlock: space.md,
    paddingInline: 22,
    borderRadius: radius.round,
    backgroundColor: { default: color.ink, ":hover": "#3a3732" },
    color: "white",
    fontSize: 15,
    fontWeight: 500,
    textDecoration: "none",
  },
  meta: { margin: 0, paddingInline: space.sm, color: color.muted, fontSize: 12.5 },
});

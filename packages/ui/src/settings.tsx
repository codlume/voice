import * as stylex from "@stylexjs/stylex";
import { Button } from "@base-ui/react/button";
import type { ReactNode } from "react";
import { tokens } from "./tokens.stylex";

export const dark = stylex.createTheme(tokens, {
  background: "#17202e",
  panel: "#202e40",
  ink: "#e9eff7",
  muted: "#b0bfd2",
  border: "#3a4d63",
  accent: "#95bcff",
});
const styles = stylex.create({
  page: {
    minHeight: "100vh",
    backgroundColor: tokens.background,
    color: tokens.ink,
    padding: 40,
    boxSizing: "border-box",
    fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
  },
  content: { maxWidth: 650, marginInline: "auto" },
  brand: {
    fontSize: 17,
    fontWeight: 650,
    letterSpacing: "-0.4px",
    color: tokens.accent,
    marginBottom: 40,
  },
  title: { fontSize: 30, fontWeight: 550, letterSpacing: "-0.8px", marginBlock: 0 },
  description: { color: tokens.muted, fontSize: 14, lineHeight: 1.6, marginBottom: 28 },
  panel: {
    backgroundColor: tokens.panel,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: tokens.border,
    borderRadius: 14,
    padding: 24,
  },
  button: {
    backgroundColor: tokens.ink,
    color: tokens.panel,
    borderWidth: 0,
    borderRadius: 7,
    paddingBlock: 10,
    paddingInline: 16,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    opacity: { default: 1, ":disabled": 0.45 },
    outlineColor: tokens.accent,
    outlineOffset: 3,
  },
});

export function SettingsPage({
  appearance,
  children,
}: {
  appearance: "light" | "dark";
  children: ReactNode;
}) {
  return (
    <main {...stylex.props(styles.page, appearance === "dark" && dark)}>
      <div {...stylex.props(styles.content)}>
        <div {...stylex.props(styles.brand)}>Voice / Preferences</div>
        <h1 {...stylex.props(styles.title)}>Make yourself at home.</h1>
        <p {...stylex.props(styles.description)}>A quieter place to set up your dictation.</p>
        <section {...stylex.props(styles.panel)} aria-label="Voice settings">
          {children}
        </section>
      </div>
    </main>
  );
}
export function SaveButton({ children, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button {...stylex.props(styles.button)} {...props}>
      {children}
    </Button>
  );
}

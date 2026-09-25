import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import type { Snapshot } from "../shared/api.ts";
import { Home } from "./Home.tsx";
import { Settings } from "./Settings.tsx";
import { color, font, radius, space } from "./tokens.stylex.ts";

const pages = [
  { id: "home", label: "Home" },
  { id: "settings", label: "Settings" },
] as const;

type Page = (typeof pages)[number]["id"];

const styles = stylex.create({
  shell: {
    display: "flex",
    minHeight: "100vh",
    backgroundColor: color.page,
    color: color.ink,
    fontFamily: font.sans,
    fontSize: 14,
    lineHeight: 1.45,
    WebkitFontSmoothing: "antialiased",
  },
  sidebar: {
    flexShrink: 0,
    width: 196,
    paddingBlock: space.lg,
    paddingInline: space.md,
    backgroundColor: color.sidebar,
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: color.border,
  },
  brand: {
    margin: 0,
    paddingInline: space.md,
    paddingBottom: space.lg,
    fontFamily: font.serif,
    fontSize: 20,
    fontWeight: 500,
  },
  nav: { display: "flex", flexDirection: "column", gap: 2 },
  navItem: {
    paddingBlock: 7,
    paddingInline: space.md,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: "transparent", ":hover": color.hover },
    color: color.muted,
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
  },
  navItemCurrent: {
    backgroundColor: { default: color.selected, ":hover": color.selected },
    color: color.ink,
    fontWeight: 500,
  },
  main: {
    flexGrow: 1,
    minWidth: 0,
    paddingBlock: space.xxl,
    paddingInline: space.xxl,
  },
  column: { maxWidth: 600, marginInline: "auto" },
});

export function HubShell({ snapshot }: { snapshot: Snapshot }) {
  const [page, setPage] = useState<Page>("home");
  return (
    <div {...stylex.props(styles.shell)}>
      <aside {...stylex.props(styles.sidebar)}>
        <p {...stylex.props(styles.brand)}>Voice</p>
        <nav aria-label="Voice" {...stylex.props(styles.nav)}>
          {pages.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-current={page === id ? "page" : undefined}
              onClick={() => setPage(id)}
              {...stylex.props(styles.navItem, page === id && styles.navItemCurrent)}
            >
              {label}
            </button>
          ))}
        </nav>
      </aside>
      <main {...stylex.props(styles.main)}>
        <div {...stylex.props(styles.column)}>
          {page === "home" ? (
            <Home snapshot={snapshot} />
          ) : (
            <Settings settings={snapshot.settings} />
          )}
        </div>
      </main>
    </div>
  );
}

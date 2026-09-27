import { Tooltip } from "@base-ui/react/tooltip";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState, type ReactNode } from "react";

import iconUrl from "../../build/icon.svg";
import type { Snapshot } from "../shared/api.ts";
import { Home } from "./Home.tsx";
import { Settings } from "./Settings.tsx";
import { Style } from "./Style.tsx";
import { SidebarUpdates } from "./Updates.tsx";
import { color, font, radius, space } from "./tokens.stylex.ts";

const pages = [
  {
    id: "home",
    label: "Home",
    icon: (
      <path d="M3.5 8.75 10 3.5l6.5 5.25V16a.5.5 0 0 1-.5.5h-3.5V12h-5v4.5H4a.5.5 0 0 1-.5-.5z" />
    ),
  },
  {
    id: "style",
    label: "Style",
    icon: (
      <>
        <path d="m4 13.5-.75 3.25L6.5 16l9.75-9.75a1.77 1.77 0 0 0-2.5-2.5zM12 5.5 14.5 8" />
        <path d="M10 16.75h6.75" />
      </>
    ),
  },
] as const;

type Page = (typeof pages)[number]["id"] | "settings";

const sidebarCollapsedKey = "voice.sidebarCollapsed";
const sidebarId = "hub-sidebar";

const sidebarPadding = 12;
const sidebarWidth = 196;
const navItemSize = 36;
const navIconSize = 18;
const railWidth = navItemSize + 2 * sidebarPadding;

const brandIconVisibleSize = 24;
const macIconGridMargin = 100 / 1024;
const brandIconSize = brandIconVisibleSize / (1 - 2 * macIconGridMargin);

const reducedMotion = "@media (prefers-reduced-motion: reduce)";
const easing = "cubic-bezier(0.2, 0, 0, 1)";

const styles = stylex.create({
  shell: {
    display: "grid",
    gridTemplateRows: "48px 1fr",
    gridTemplateColumns: "auto 1fr",
    height: "100vh",
    backgroundColor: color.sidebar,
    color: color.foreground,
    fontFamily: font.sans,
    fontSize: 14,
    lineHeight: 1.45,
    WebkitFontSmoothing: "antialiased",
  },
  titlebar: {
    gridColumn: "1 / -1",
    display: "flex",
    alignItems: "center",
    paddingLeft: 92,
    WebkitAppRegion: "drag",
  },
  toggle: {
    display: "grid",
    placeItems: "center",
    width: 28,
    height: 28,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: "transparent", ":hover": color.sidebarRowHover },
    color: color.mutedForeground,
    cursor: "pointer",
    WebkitAppRegion: "no-drag",
  },
  sidebar: {
    width: sidebarWidth,
    overflow: "hidden",
    whiteSpace: "nowrap",
    paddingBlock: space.lg,
    paddingInline: sidebarPadding,
    display: "flex",
    flexDirection: "column",
    transitionProperty: "width",
    transitionDuration: { default: "220ms", [reducedMotion]: "0s" },
    transitionTimingFunction: easing,
  },
  sidebarCollapsed: { width: railWidth },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    margin: 0,
    paddingInline: (navItemSize - brandIconVisibleSize) / 2,
    paddingBottom: space.lg,
    fontFamily: font.serif,
    fontSize: 20,
    fontWeight: 500,
  },
  brandIcon: {
    flexShrink: 0,
    width: brandIconSize,
    height: brandIconSize,
    margin: -(brandIconSize - brandIconVisibleSize) / 2,
  },
  nav: { display: "flex", flexDirection: "column", gap: 2 },
  navItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    overflow: "hidden",
    height: navItemSize,
    padding: 0,
    paddingInline: (navItemSize - navIconSize) / 2,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: "transparent", ":hover": color.sidebarRowHover },
    color: color.mutedForeground,
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
  },
  navItemCurrent: {
    backgroundColor: { default: color.sidebarRowSelected, ":hover": color.sidebarRowSelected },
    color: color.foreground,
    fontWeight: 500,
  },
  icon: { flexShrink: 0 },
  label: {
    transitionProperty: "opacity",
    transitionDuration: { default: "150ms", [reducedMotion]: "0s" },
    transitionTimingFunction: easing,
  },
  labelHidden: { opacity: 0 },
  footer: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.sm,
    width: sidebarWidth - 2 * sidebarPadding,
    marginTop: "auto",
    paddingTop: space.lg,
    whiteSpace: "normal",
  },
  footerButton: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 32,
    height: 32,
    paddingInline: 0,
    borderRadius: radius.round,
  },
  footerUpdates: {
    flex: 1,
    minWidth: 0,
    transitionProperty: "opacity, visibility",
    transitionDuration: { default: "150ms", [reducedMotion]: "0s" },
    transitionTimingFunction: easing,
  },
  footerHidden: { opacity: 0, visibility: "hidden" },
  tooltipPositioner: {
    zIndex: 10,
    width: "var(--positioner-width)",
    height: "var(--positioner-height)",
    transitionProperty: "left, right, top, bottom",
    transitionDuration: { default: "180ms", [reducedMotion]: "0s" },
    transitionTimingFunction: easing,
  },
  tooltip: {
    width: "var(--popup-width)",
    height: "var(--popup-height)",
    overflow: "hidden",
    whiteSpace: "nowrap",
    paddingBlock: 5,
    paddingInline: space.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.small,
    backgroundColor: color.card,
    color: color.foreground,
    boxShadow: "0 2px 8px rgb(0 0 0 / 12%)",
    fontFamily: font.sans,
    fontSize: 12,
    lineHeight: 1.4,
    WebkitFontSmoothing: "antialiased",
    opacity: 1,
    transitionProperty: "opacity, width, height",
    transitionDuration: { default: "180ms", [reducedMotion]: "0s" },
    transitionTimingFunction: easing,
  },
  tooltipHidden: { opacity: 0 },
  tooltipInstant: { transitionDuration: "0s" },
  main: {
    minWidth: 0,
    overflow: "auto",
    marginRight: 8,
    marginBottom: 8,
    paddingBlock: space.xxl,
    paddingInline: space.xxl,
    backgroundColor: color.background,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.large,
  },
  styleMain: { paddingBlock: space.xl },
  column: { maxWidth: 600, marginInline: "auto" },
});

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      width={navIconSize}
      height={navIconSize}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...stylex.props(styles.icon)}
    >
      {children}
    </svg>
  );
}

function SidebarTooltip({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  return (
    <Tooltip.Provider delay={0} closeDelay={100}>
      <Tooltip.Root<string> disabled={!collapsed}>
        {({ payload }) => (
          <>
            {children}
            <Tooltip.Portal>
              <Tooltip.Positioner
                side="right"
                align="center"
                sideOffset={10}
                className={({ instant }) =>
                  stylex.props(
                    styles.tooltipPositioner,
                    (instant === "focus" || instant === "dismiss") && styles.tooltipInstant,
                  ).className
                }
              >
                <Tooltip.Popup
                  className={({ transitionStatus, instant }) =>
                    stylex.props(
                      styles.tooltip,
                      (transitionStatus === "starting" || transitionStatus === "ending") &&
                        styles.tooltipHidden,
                      (instant === "focus" || instant === "dismiss") && styles.tooltipInstant,
                    ).className
                  }
                >
                  <Tooltip.Viewport className="sidebar-tooltip-viewport">
                    {payload}
                  </Tooltip.Viewport>
                </Tooltip.Popup>
              </Tooltip.Positioner>
            </Tooltip.Portal>
          </>
        )}
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

export function HubShell({ snapshot }: { snapshot: Snapshot }) {
  const [page, setPage] = useState<Page>("home");
  const mainRef = useRef<HTMLElement>(null);
  // The card is the only scroller, and PageDown or Space only scroll a focused scroller.
  const focusMain = () => mainRef.current?.focus({ preventScroll: true });
  useEffect(focusMain, []);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(sidebarCollapsedKey) === "true",
  );

  function toggleSidebar() {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(sidebarCollapsedKey, String(next));
  }

  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <div {...stylex.props(styles.shell)}>
      <div {...stylex.props(styles.titlebar)}>
        <button
          type="button"
          aria-label={toggleLabel}
          title={toggleLabel}
          aria-expanded={!collapsed}
          aria-controls={sidebarId}
          onClick={toggleSidebar}
          {...stylex.props(styles.toggle)}
        >
          <Icon>
            <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2.5" />
            <path d="M7.75 3.75v12.5" />
          </Icon>
        </button>
      </div>
      <SidebarTooltip collapsed={collapsed}>
        <aside
          id={sidebarId}
          onClick={(event) => {
            if (!(event.target instanceof Element) || event.target.closest("button")) return;
            toggleSidebar();
          }}
          {...stylex.props(styles.sidebar, collapsed && styles.sidebarCollapsed)}
        >
          <p {...stylex.props(styles.brand)}>
            <img src={iconUrl} alt="" draggable={false} {...stylex.props(styles.brandIcon)} />
            <span {...stylex.props(styles.label, collapsed && styles.labelHidden)}>Voice</span>
          </p>
          <nav aria-label="Voice" {...stylex.props(styles.nav)}>
            {pages.map(({ id, label, icon }) => (
              <Tooltip.Trigger
                key={id}
                payload={label}
                type="button"
                aria-current={page === id ? "page" : undefined}
                onClick={() => {
                  setPage(id);
                  focusMain();
                }}
                {...stylex.props(styles.navItem, page === id && styles.navItemCurrent)}
              >
                <Icon>{icon}</Icon>
                <span {...stylex.props(styles.label, collapsed && styles.labelHidden)}>
                  {label}
                </span>
              </Tooltip.Trigger>
            ))}
          </nav>
          <div {...stylex.props(styles.footer)}>
            <Tooltip.Trigger
              payload="Settings"
              type="button"
              aria-label="Settings"
              title={collapsed ? undefined : "Settings"}
              aria-current={page === "settings" ? "page" : undefined}
              onClick={() => {
                setPage("settings");
                focusMain();
              }}
              {...stylex.props(
                styles.navItem,
                styles.footerButton,
                page === "settings" && styles.navItemCurrent,
              )}
            >
              <Icon>
                <path d="M3.5 6h7M14.5 6h2M3.5 14h2M9.5 14h7" />
                <circle cx="12.5" cy="6" r="2" />
                <circle cx="7.5" cy="14" r="2" />
              </Icon>
            </Tooltip.Trigger>
            <div {...stylex.props(styles.footerUpdates, collapsed && styles.footerHidden)}>
              <SidebarUpdates updates={snapshot.updates} session={snapshot.session} />
            </div>
          </div>
        </aside>
      </SidebarTooltip>
      <main
        ref={mainRef}
        tabIndex={-1}
        {...stylex.props(styles.main, page === "style" && styles.styleMain)}
      >
        <div {...stylex.props(styles.column)}>
          {page === "home" && <Home snapshot={snapshot} />}
          {page === "style" && <Style settings={snapshot.settings} />}
          {page === "settings" && (
            <Settings
              settings={snapshot.settings}
              updates={snapshot.updates}
              microphones={snapshot.microphones}
            />
          )}
        </div>
      </main>
    </div>
  );
}

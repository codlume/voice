import { Tooltip } from "@base-ui/react/tooltip";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState, type ReactNode } from "react";

import iconUrl from "../../build/icon.svg";
import type { Snapshot } from "../shared/api.ts";
import { Home } from "./Home.tsx";
import {
  DataPrivacySettings,
  GeneralSettings,
  ShortcutsSettings,
  SystemSettings,
} from "./Settings.tsx";
import { jumpLabel, shortcuts, useShortcuts, withShortcut } from "./shortcuts.ts";
import { Style } from "./Style.tsx";
import { SidebarUpdates } from "./Updates.tsx";
import { color, font, radius, space } from "./tokens.stylex.ts";

const slidersIcon = (
  <>
    <path d="M3.5 6h7M14.5 6h2M3.5 14h2M9.5 14h7" />
    <circle cx="12.5" cy="6" r="2" />
    <circle cx="7.5" cy="14" r="2" />
  </>
);

const appPages = [
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

const settingsPages = [
  { id: "general", label: "General", icon: slidersIcon },
  {
    id: "system",
    label: "System",
    icon: (
      <>
        <rect x="2.75" y="3.5" width="14.5" height="10" rx="1.5" />
        <path d="M7 16.5h6M10 13.5v3" />
      </>
    ),
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    icon: (
      <>
        <rect x="2.5" y="5" width="15" height="10" rx="2" />
        <path d="M5.75 8.25h.01M8.6 8.25h.01M11.4 8.25h.01M14.25 8.25h.01M6.75 11.75h6.5" />
      </>
    ),
  },
  {
    id: "privacy",
    label: "Data and Privacy",
    icon: (
      <>
        <path d="M10 2.75 3.75 5.25v4.5c0 3.75 2.6 6.4 6.25 7.5 3.65-1.1 6.25-3.75 6.25-7.5v-4.5z" />
        <path d="m7.5 10.25 1.75 1.75 3.25-3.5" />
      </>
    ),
  },
] as const;

type AppPage = (typeof appPages)[number]["id"];
type SettingsPage = (typeof settingsPages)[number]["id"];

const pageViews: Record<AppPage | SettingsPage, (snapshot: Snapshot) => ReactNode> = {
  home: (snapshot) => <Home snapshot={snapshot} />,
  style: (snapshot) => <Style settings={snapshot.settings} />,
  general: (snapshot) => (
    <GeneralSettings
      settings={snapshot.settings}
      microphones={snapshot.microphones}
      microphoneTest={snapshot.microphoneTest}
      microphonePermission={snapshot.permissions.microphone}
    />
  ),
  system: (snapshot) => (
    <SystemSettings
      settings={snapshot.settings}
      loginItem={snapshot.loginItem}
      updates={snapshot.updates}
    />
  ),
  privacy: (snapshot) => <DataPrivacySettings settings={snapshot.settings} />,
  shortcuts: (snapshot) => <ShortcutsSettings settings={snapshot.settings} />,
};

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
  labelBesideHint: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
  shortcutHint: {
    flexShrink: 0,
    marginLeft: "auto",
    paddingInline: 6,
    borderRadius: radius.round,
    backgroundColor: color.segmentTrack,
    color: color.mutedForeground,
    fontFamily: "inherit",
    fontSize: 11,
    fontWeight: 400,
    lineHeight: "18px",
  },
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
  back: { flexShrink: 0, marginTop: "auto" },
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

function NavItem({
  label,
  icon,
  shortcut,
  current = false,
  collapsed,
  showShortcut,
  onClick,
  style,
}: {
  label: string;
  icon: ReactNode;
  shortcut: string | undefined;
  current?: boolean;
  collapsed: boolean;
  showShortcut: boolean;
  onClick: () => void;
  style?: stylex.StyleXStyles;
}) {
  const showHint = showShortcut && shortcut !== undefined;
  return (
    <Tooltip.Trigger
      payload={shortcut === undefined ? label : withShortcut(label, shortcut)}
      type="button"
      aria-current={current ? "page" : undefined}
      onClick={onClick}
      {...stylex.props(styles.navItem, current && styles.navItemCurrent, style)}
    >
      <Icon>{icon}</Icon>
      <span
        {...stylex.props(
          styles.label,
          collapsed && styles.labelHidden,
          showHint && styles.labelBesideHint,
        )}
      >
        {label}
      </span>
      {showHint && (
        <kbd aria-hidden="true" {...stylex.props(styles.shortcutHint)}>
          {shortcut}
        </kbd>
      )}
    </Tooltip.Trigger>
  );
}

function NavItems<Id extends string>({
  items,
  current,
  collapsed,
  showShortcut,
  onSelect,
}: {
  items: readonly { id: Id; label: string; icon: ReactNode }[];
  current: Id;
  collapsed: boolean;
  showShortcut: boolean;
  onSelect: (id: Id) => void;
}) {
  return items.map(({ id, label, icon }, index) => (
    <NavItem
      key={id}
      label={label}
      icon={icon}
      shortcut={jumpLabel(index)}
      current={current === id}
      collapsed={collapsed}
      showShortcut={showShortcut}
      onClick={() => onSelect(id)}
    />
  ));
}

export function HubShell({ snapshot }: { snapshot: Snapshot }) {
  const [appPage, setAppPage] = useState<AppPage>("home");
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(null);
  const page = settingsPage ?? appPage;
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

  function selectAppPage(id: AppPage) {
    setAppPage(id);
    focusMain();
  }

  function selectSettingsPage(id: SettingsPage) {
    setSettingsPage(id);
    focusMain();
  }

  function openSettings() {
    if (settingsPage === null) selectSettingsPage("general");
  }

  function closeSettings() {
    if (settingsPage === null) return;
    setSettingsPage(null);
    focusMain();
  }

  function jump(index: number) {
    if (settingsPage === null) {
      const item = appPages.at(index);
      if (item) selectAppPage(item.id);
    } else {
      const item = settingsPages.at(index);
      if (item) selectSettingsPage(item.id);
    }
  }

  const showShortcut =
    useShortcuts({ toggleSidebar, openSettings, closeSettings, jump }) && !collapsed;

  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";
  const settingsLabel = withShortcut("Settings", shortcuts.openSettings.hint);
  return (
    <div {...stylex.props(styles.shell)}>
      <div {...stylex.props(styles.titlebar)}>
        <button
          type="button"
          aria-label={toggleLabel}
          title={withShortcut(toggleLabel, shortcuts.toggleSidebar.hint)}
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
          {settingsPage === null ? (
            <>
              <nav aria-label="Voice" {...stylex.props(styles.nav)}>
                <NavItems
                  items={appPages}
                  current={appPage}
                  collapsed={collapsed}
                  showShortcut={showShortcut}
                  onSelect={selectAppPage}
                />
              </nav>
              <div {...stylex.props(styles.footer)}>
                <Tooltip.Trigger
                  payload={settingsLabel}
                  type="button"
                  aria-label="Settings"
                  title={collapsed ? undefined : settingsLabel}
                  onClick={openSettings}
                  {...stylex.props(styles.navItem, styles.footerButton)}
                >
                  <Icon>{slidersIcon}</Icon>
                </Tooltip.Trigger>
                <div {...stylex.props(styles.footerUpdates, collapsed && styles.footerHidden)}>
                  <SidebarUpdates updates={snapshot.updates} session={snapshot.session} />
                </div>
              </div>
            </>
          ) : (
            <>
              <nav aria-label="Settings" {...stylex.props(styles.nav)}>
                <NavItems
                  items={settingsPages}
                  current={settingsPage}
                  collapsed={collapsed}
                  showShortcut={showShortcut}
                  onSelect={selectSettingsPage}
                />
              </nav>
              <NavItem
                label="Back"
                icon={<path d="M16 10H4M8.5 5.5 4 10l4.5 4.5" />}
                shortcut={shortcuts.closeSettings.hint}
                collapsed={collapsed}
                showShortcut={showShortcut}
                onClick={closeSettings}
                style={styles.back}
              />
            </>
          )}
        </aside>
      </SidebarTooltip>
      <main
        ref={mainRef}
        tabIndex={-1}
        {...stylex.props(styles.main, page === "style" && styles.styleMain)}
      >
        <div {...stylex.props(styles.column)}>{pageViews[page](snapshot)}</div>
      </main>
    </div>
  );
}

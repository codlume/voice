import { Tooltip } from "@base-ui/react/tooltip";
import * as stylex from "@stylexjs/stylex";
import {
  ArrowLeftIcon,
  BoxIcon,
  HouseIcon,
  KeyboardIcon,
  MonitorIcon,
  PanelLeftIcon,
  PenLineIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  UserIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import iconUrl from "../../build/icon.svg";
import type { Snapshot } from "../shared/api.ts";
import { TITLEBAR_HEIGHT, trafficLightsInset } from "../shared/titlebar.ts";
import { AccountSettings } from "./Account.tsx";
import { Home } from "./Home.tsx";
import {
  DataPrivacySettings,
  GeneralSettings,
  ModelsSettings,
  ShortcutsSettings,
  SystemSettings,
} from "./Settings.tsx";
import {
  jumpShortcuts,
  shortcuts,
  useCommandHeld,
  useShortcuts,
  withShortcut,
  type Binding,
  type Shortcut,
} from "./shortcuts.ts";
import { Style } from "./Style.tsx";
import { titlebar } from "./titlebar.ts";
import { TitlebarAccount } from "./TitlebarAccount.tsx";
import { SidebarUpdates } from "./Updates.tsx";
import { color, font, radius, space } from "./tokens.stylex.ts";

const appPages = [
  { id: "home", label: "Home", icon: HouseIcon },
  { id: "style", label: "Style", icon: PenLineIcon },
] as const;

const settingsPages = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon },
  { id: "account", label: "Account", icon: UserIcon },
  { id: "system", label: "System", icon: MonitorIcon },
  { id: "models", label: "Models", icon: BoxIcon },
  { id: "shortcuts", label: "Shortcuts", icon: KeyboardIcon },
  { id: "privacy", label: "Data and Privacy", icon: ShieldCheckIcon },
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
      updates={snapshot.updates}
    />
  ),
  account: (snapshot) => (
    <AccountSettings
      account={snapshot.account}
      otherChannelSignedIn={snapshot.otherChannelSignedIn}
    />
  ),
  system: (snapshot) => (
    <SystemSettings settings={snapshot.settings} loginItem={snapshot.loginItem} />
  ),
  models: (snapshot) => (
    <ModelsSettings
      models={snapshot.models}
      settings={snapshot.settings}
      session={snapshot.session}
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
    gridTemplateRows: "auto 1fr",
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
    justifyContent: "space-between",
    paddingRight: 12,
    WebkitAppRegion: "drag",
  },
  titlebarGeometry: (zoomLevel: number) => ({
    height: TITLEBAR_HEIGHT,
    paddingLeft: trafficLightsInset(zoomLevel),
  }),
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
    alignItems: "center",
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
    marginLeft: "auto",
    transitionProperty: "opacity, visibility",
    transitionDuration: { default: "150ms", [reducedMotion]: "0s" },
    transitionTimingFunction: easing,
  },
  footerHidden: { opacity: 0, visibility: "hidden" },
  back: { flex: 1 },
  backCollapsed: { flex: "none", width: navItemSize },
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
  column: { maxWidth: 800, marginInline: "auto" },
});

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
  icon: Icon,
  shortcut,
  current = false,
  collapsed,
  showShortcut,
  onClick,
  style,
}: {
  label: string;
  icon: LucideIcon;
  shortcut: Shortcut | undefined;
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
      <Icon size={navIconSize} {...stylex.props(styles.icon)} />
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
          {shortcut.hint}
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
  items: readonly { id: Id; label: string; icon: LucideIcon }[];
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
      shortcut={jumpShortcuts[index]}
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
  // A sign-in error can arrive from the browser while another page shows, or before the hub
  // opens, as when the browser finishes a sign-in that a quit cut short.
  const accountKind = snapshot.account.kind;
  const [shownAccountKind, setShownAccountKind] = useState<typeof accountKind | null>(null);
  if (accountKind !== shownAccountKind) {
    setShownAccountKind(accountKind);
    if (accountKind === "error") setSettingsPage("account");
  }
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

  function closeSettings() {
    setSettingsPage(null);
    focusMain();
  }

  const navTargets =
    settingsPage === null
      ? appPages.map(
          ({ id }) =>
            () =>
              selectAppPage(id),
        )
      : settingsPages.map(
          ({ id }) =>
            () =>
              selectSettingsPage(id),
        );

  useShortcuts([
    { shortcut: shortcuts.toggleSidebar, run: toggleSidebar },
    settingsPage === null
      ? { shortcut: shortcuts.openSettings, run: () => selectSettingsPage("general") }
      : { shortcut: shortcuts.closeSettings, run: closeSettings },
    ...navTargets.flatMap((run, index): Binding[] => {
      const shortcut = jumpShortcuts[index];
      return shortcut ? [{ shortcut, run }] : [];
    }),
  ]);
  const showShortcut = useCommandHeld(snapshot.settings.hotkey) && !collapsed;

  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";
  const settingsLabel = withShortcut("Settings", shortcuts.openSettings);
  return (
    <div {...stylex.props(styles.shell)}>
      <div {...stylex.props(styles.titlebar, styles.titlebarGeometry(snapshot.settings.zoomLevel))}>
        <button
          type="button"
          aria-label={toggleLabel}
          title={withShortcut(toggleLabel, shortcuts.toggleSidebar)}
          aria-expanded={!collapsed}
          aria-controls={sidebarId}
          onClick={toggleSidebar}
          {...stylex.props(titlebar.button)}
        >
          <PanelLeftIcon size={navIconSize} />
        </button>
        <TitlebarAccount
          account={snapshot.account}
          onOpenAccount={() => selectSettingsPage("account")}
        />
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
            <nav aria-label="Voice" {...stylex.props(styles.nav)}>
              <NavItems
                items={appPages}
                current={appPage}
                collapsed={collapsed}
                showShortcut={showShortcut}
                onSelect={selectAppPage}
              />
            </nav>
          ) : (
            <nav aria-label="Settings" {...stylex.props(styles.nav)}>
              <NavItems
                items={settingsPages}
                current={settingsPage}
                collapsed={collapsed}
                showShortcut={showShortcut}
                onSelect={selectSettingsPage}
              />
            </nav>
          )}
          <div {...stylex.props(styles.footer)}>
            {settingsPage === null ? (
              <Tooltip.Trigger
                payload={settingsLabel}
                type="button"
                aria-label="Settings"
                title={collapsed ? undefined : settingsLabel}
                onClick={() => selectSettingsPage("general")}
                {...stylex.props(styles.navItem, styles.footerButton)}
              >
                <SlidersHorizontalIcon size={navIconSize} />
              </Tooltip.Trigger>
            ) : (
              <NavItem
                label="Back"
                icon={ArrowLeftIcon}
                shortcut={shortcuts.closeSettings}
                collapsed={collapsed}
                showShortcut={showShortcut}
                onClick={closeSettings}
                style={[styles.back, collapsed && styles.backCollapsed]}
              />
            )}
            <div {...stylex.props(styles.footerUpdates, collapsed && styles.footerHidden)}>
              <SidebarUpdates
                updates={snapshot.updates}
                session={snapshot.session}
                last={snapshot.last}
              />
            </div>
          </div>
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

import { Tooltip } from "@base-ui/react/tooltip";
import * as stylex from "@stylexjs/stylex";
import {
  ArrowLeftIcon,
  BookAIcon,
  BoxIcon,
  ChartColumnIcon,
  HouseIcon,
  KeyboardIcon,
  MonitorIcon,
  PanelLeftIcon,
  PenLineIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  TextQuoteIcon,
  UserIcon,
  WandSparklesIcon,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import iconUrl from "../../build/icon.svg";
import type { Snapshot } from "../shared/api.ts";
import type { HistoryState } from "../shared/history.ts";
import { TITLEBAR_HEIGHT, trafficLightsInset } from "../shared/titlebar.ts";
import { AccountSettings } from "./Account.tsx";
import { Dictionary } from "./Dictionary.tsx";
import { Home } from "./Home.tsx";
import { Insights } from "./Insights.tsx";
import { pageMotion, type PageMotion } from "./pageMotion.ts";
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
import { Snippets } from "./Snippets.tsx";
import { Style } from "./Style.tsx";
import { Transforms } from "./Transforms.tsx";
import { titlebar } from "./titlebar.ts";
import { TitlebarAccount } from "./TitlebarAccount.tsx";
import { SidebarUpdates } from "./Updates.tsx";
import { color, font, radius, space } from "./tokens.stylex.ts";
import { tooltipPopupClass, tooltipPositionerClass } from "./tooltip.ts";

const appPageGroups = [
  [
    { id: "home", label: "Home", icon: HouseIcon },
    { id: "insights", label: "Insights", icon: ChartColumnIcon },
    { id: "style", label: "Style", icon: PenLineIcon },
    { id: "transforms", label: "Transforms", icon: WandSparklesIcon },
    { id: "snippets", label: "Snippets", icon: TextQuoteIcon },
    { id: "dictionary", label: "Dictionary", icon: BookAIcon },
  ],
] as const;

const settingsPageGroups = [
  [
    { id: "general", label: "General", icon: SlidersHorizontalIcon },
    { id: "system", label: "System", icon: MonitorIcon },
    { id: "models", label: "Models", icon: BoxIcon },
    { id: "shortcuts", label: "Shortcuts", icon: KeyboardIcon },
  ],
  [
    { id: "account", label: "Account", icon: UserIcon },
    { id: "privacy", label: "Data and Privacy", icon: ShieldCheckIcon },
  ],
] as const;

const appPages = appPageGroups.flat();
const settingsPages = settingsPageGroups.flat();

type AppPage = (typeof appPages)[number]["id"];
type SettingsPage = (typeof settingsPages)[number]["id"];

type PageView = {
  snapshot: Snapshot;
  history: HistoryState;
  openPage: (id: AppPage) => void;
  openSettingsPage: (id: SettingsPage) => void;
};

const pageViews: Record<AppPage | SettingsPage, (view: PageView) => ReactNode> = {
  home: ({ snapshot, history, openPage }) => (
    <Home snapshot={snapshot} history={history} onOpenInsights={() => openPage("insights")} />
  ),
  insights: ({ snapshot }) => <Insights assignments={snapshot.settings.cleanup.assignments} />,
  style: ({ snapshot }) => <Style settings={snapshot.settings} />,
  transforms: ({ snapshot, openSettingsPage }) => (
    <Transforms
      settings={snapshot.settings}
      model={snapshot.models.transform}
      onOpenModels={() => openSettingsPage("models")}
    />
  ),
  snippets: ({ snapshot }) => (
    <Snippets snippets={snapshot.settings.snippets} dictionary={snapshot.settings.dictionary} />
  ),
  dictionary: ({ snapshot }) => (
    <Dictionary dictionary={snapshot.settings.dictionary} snippets={snapshot.settings.snippets} />
  ),
  general: ({ snapshot }) => (
    <GeneralSettings
      settings={snapshot.settings}
      microphones={snapshot.microphones}
      microphoneTest={snapshot.microphoneTest}
      microphonePermission={snapshot.permissions.microphone}
      updates={snapshot.updates}
    />
  ),
  account: ({ snapshot }) => <AccountSettings account={snapshot.account} />,
  system: ({ snapshot }) => (
    <SystemSettings settings={snapshot.settings} loginItem={snapshot.loginItem} />
  ),
  models: ({ snapshot }) => (
    <ModelsSettings
      models={snapshot.models}
      settings={snapshot.settings}
      session={snapshot.session}
    />
  ),
  privacy: ({ snapshot, history }) => (
    <DataPrivacySettings settings={snapshot.settings} history={history} />
  ),
  shortcuts: ({ snapshot, openPage }) => (
    <ShortcutsSettings
      settings={snapshot.settings}
      transformModel={snapshot.models.transform}
      onOpenTransforms={() => openPage("transforms")}
    />
  ),
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
  pageAnimation: (ms: number) => ({ "--page-animation": `${ms}ms` }),
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
    transitionDuration: { default: "var(--page-animation)", [reducedMotion]: "0s" },
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
  navDivider: {
    flexShrink: 0,
    height: 1,
    borderWidth: 0,
    marginBlock: space.sm,
    marginInline: (navItemSize - navIconSize) / 2,
    backgroundColor: color.border,
  },
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
    transitionDuration: { default: "calc(var(--page-animation) * 0.75)", [reducedMotion]: "0s" },
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
    transitionDuration: { default: "calc(var(--page-animation) * 0.75)", [reducedMotion]: "0s" },
    transitionTimingFunction: easing,
  },
  footerHidden: { opacity: 0, visibility: "hidden" },
  back: { flex: 1 },
  backCollapsed: { flex: "none", width: navItemSize },
  // One tooltip glides between the rail's triggers, resizing to each label.
  tooltipGlide: {
    width: "var(--positioner-width)",
    height: "var(--positioner-height)",
    transitionProperty: "left, right, top, bottom",
    transitionDuration: { default: "180ms", [reducedMotion]: "0s" },
    transitionTimingFunction: easing,
  },
  tooltipResize: {
    width: "var(--popup-width)",
    height: "var(--popup-height)",
    overflow: "hidden",
    transitionProperty: "opacity, width, height",
  },
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
                className={tooltipPositionerClass(styles.tooltipGlide)}
              >
                <Tooltip.Popup className={tooltipPopupClass(styles.tooltipResize)}>
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
  groups,
  current,
  collapsed,
  showShortcut,
  onSelect,
}: {
  groups: readonly (readonly { id: Id; label: string; icon: LucideIcon }[])[];
  current: Id;
  collapsed: boolean;
  showShortcut: boolean;
  onSelect: (id: Id) => void;
}) {
  let index = 0;
  return groups.map((items, groupIndex) => (
    <Fragment key={groupIndex}>
      {groupIndex > 0 && <hr {...stylex.props(styles.navDivider)} />}
      {items.map(({ id, label, icon }) => (
        <NavItem
          key={id}
          label={label}
          icon={icon}
          shortcut={jumpShortcuts[index++]}
          current={current === id}
          collapsed={collapsed}
          showShortcut={showShortcut}
          onClick={() => onSelect(id)}
        />
      ))}
    </Fragment>
  ));
}

export function HubShell({ snapshot, history }: { snapshot: Snapshot; history: HistoryState }) {
  const [appPage, setAppPage] = useState<AppPage>("home");
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(() =>
    snapshot.account.kind === "error" ? "account" : null,
  );
  const page = settingsPage ?? appPage;
  const level = settingsPage === null ? "app" : "settings";
  const [shown, setShown] = useState<{
    page: typeof page;
    level: typeof level;
    motion: PageMotion | null;
    navMotion: PageMotion | null;
  }>({ page, level, motion: null, navMotion: null });
  if (shown.page !== page) {
    const sameLevel = shown.level === level;
    const navMotion = sameLevel ? shown.navMotion : level === "settings" ? "forward" : "back";
    setShown({ page, level, motion: sameLevel ? "rise" : navMotion, navMotion });
  }
  const mainRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [page]);
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
    setSettingsPage(null);
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
  const showShortcut = useCommandHeld(snapshot.settings) && !collapsed;

  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";
  const settingsLabel = withShortcut("Settings", shortcuts.openSettings);
  const Page = pageViews[page];
  return (
    <div {...stylex.props(styles.shell, styles.pageAnimation(snapshot.settings.pageAnimationMs))}>
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
            <nav
              key="app"
              aria-label="Voice"
              {...stylex.props(styles.nav, shown.navMotion && pageMotion[shown.navMotion])}
            >
              <NavItems
                groups={appPageGroups}
                current={appPage}
                collapsed={collapsed}
                showShortcut={showShortcut}
                onSelect={selectAppPage}
              />
            </nav>
          ) : (
            <nav
              key="settings"
              aria-label="Settings"
              {...stylex.props(styles.nav, shown.navMotion && pageMotion[shown.navMotion])}
            >
              <NavItems
                groups={settingsPageGroups}
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
                history={history}
              />
            </div>
          </div>
        </aside>
      </SidebarTooltip>
      <main ref={mainRef} tabIndex={-1} {...stylex.props(styles.main)}>
        <div key={page} {...stylex.props(styles.column, shown.motion && pageMotion[shown.motion])}>
          <Page
            snapshot={snapshot}
            history={history}
            openPage={selectAppPage}
            openSettingsPage={selectSettingsPage}
          />
        </div>
      </main>
    </div>
  );
}

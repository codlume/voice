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
  type LucideIcon,
} from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import {
  AnimatePresence,
  LayoutGroup,
  LazyMotion,
  MotionConfig,
  domMax,
  m,
  useReducedMotion,
  type Variants,
} from "motion/react";

import iconUrl from "../../build/icon.svg";
import type { Snapshot } from "../shared/api.ts";
import type { HistoryState } from "../shared/history.ts";
import { TITLEBAR_HEIGHT, trafficLightsInset } from "../shared/titlebar.ts";
import { AccountSettings } from "./Account.tsx";
import { Dictionary } from "./Dictionary.tsx";
import { Home } from "./Home.tsx";
import { Insights } from "./Insights.tsx";
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
};

const pageViews: Record<AppPage | SettingsPage, (view: PageView) => ReactNode> = {
  home: ({ snapshot, history, openPage }) => (
    <Home snapshot={snapshot} history={history} onOpenInsights={() => openPage("insights")} />
  ),
  insights: ({ snapshot }) => <Insights assignments={snapshot.settings.cleanup.assignments} />,
  style: ({ snapshot }) => <Style settings={snapshot.settings} />,
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
  shortcuts: ({ snapshot }) => <ShortcutsSettings settings={snapshot.settings} />,
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

// Prototype switch: ?motion=none|fade|crossfade|directional and ?indicator=1, read once.
const motionParams = new URLSearchParams(location.search);
const motion = motionParams.get("motion") ?? "none";
const glidingIndicator = motionParams.get("indicator") === "1";
document.documentElement.dataset.motion = motion;
const prefersReducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

// Which way the user moved, as a view transition type the CSS in style.css keys on.
type PageChange = "down" | "up" | "enter" | "exit";
type PageTarget = { app: AppPage; settings: SettingsPage | null };

function pageOrder({ app, settings }: PageTarget) {
  return settings === null
    ? appPages.findIndex((page) => page.id === app)
    : settingsPages.findIndex((page) => page.id === settings);
}

function pageChange(from: PageTarget, to: PageTarget): PageChange {
  if (from.settings === null && to.settings !== null) return "enter";
  if (from.settings !== null && to.settings === null) return "exit";
  return pageOrder(to) >= pageOrder(from) ? "down" : "up";
}

function commitPageChange(change: PageChange, update: () => void) {
  const viewTransition = motion === "crossfade" || motion === "directional";
  if (!viewTransition || !document.startViewTransition || prefersReducedMotion.matches) {
    update();
    return;
  }
  // The page group sits where the new page is, so the old snapshot is shifted back to where it
  // was scrolled. Otherwise a scrolled page snaps to the card's top while it fades out.
  const card = document.querySelector<HTMLElement>('[data-vt="card"]');
  const scrolledFrom = card?.scrollTop ?? 0;
  document.startViewTransition({
    update: () => {
      flushSync(update);
      const shift = (card?.scrollTop ?? 0) - scrolledFrom;
      document.documentElement.style.setProperty("--hub-old-shift", `${shift}px`);
    },
    types: motion === "directional" ? [change] : [],
  });
}

// motion=motion: the same choreography as `directional`, driven by the Motion library.
type MotionCustom = { change: PageChange; instant: boolean };
const motionEase = [0.2, 0, 0, 1] as const;
const isLevelChange = (change: PageChange) => change === "enter" || change === "exit";

function motionVariants(slide: number): Variants {
  const seconds = (instant: boolean, value: number) => (instant ? 0 : value);
  return {
    enter: ({ change }: MotionCustom) =>
      isLevelChange(change)
        ? { opacity: 0, x: change === "enter" ? slide : -slide }
        : { opacity: 0, y: 8 },
    center: ({ change, instant }: MotionCustom) => ({
      opacity: 1,
      x: 0,
      y: 0,
      transition: {
        duration: seconds(instant, isLevelChange(change) ? 0.24 : 0.2),
        ease: motionEase,
      },
    }),
    exit: ({ change, instant }: MotionCustom) =>
      isLevelChange(change)
        ? {
            opacity: 0,
            x: change === "enter" ? -slide : slide,
            transition: { duration: seconds(instant, 0.14), ease: "easeOut" },
          }
        : { opacity: 0, transition: { duration: seconds(instant, 0.09), ease: "easeOut" } },
  };
}
const motionPageVariants = motionVariants(24);
const motionNavVariants = motionVariants(12);

const pageEnter = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(6px)" },
  to: { opacity: 1, transform: "none" },
});

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
  navWithIndicator: { position: "relative", isolation: "isolate" },
  indicator: {
    position: "absolute",
    zIndex: -1,
    top: 0,
    left: 0,
    right: 0,
    height: navItemSize,
    borderRadius: radius.small,
    backgroundColor: color.sidebarRowSelected,
    transitionProperty: "transform",
    transitionDuration: { default: "200ms", [reducedMotion]: "0s" },
    transitionTimingFunction: easing,
  },
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
  motionRow: { display: "grid", position: "relative", isolation: "isolate" },
  motionIndicator: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    borderRadius: radius.small,
    backgroundColor: color.sidebarRowSelected,
  },
  positioned: { position: "relative" },
  navItemCurrentIndicated: {
    backgroundColor: { default: "transparent", ":hover": "transparent" },
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
  styleMain: { paddingBlock: space.xl },
  column: { maxWidth: 800, marginInline: "auto" },
  pageEnter: {
    animationName: { default: pageEnter, [reducedMotion]: "none" },
    animationDuration: "180ms",
    animationTimingFunction: easing,
  },
  homeColumn: { maxWidth: 1040 },
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
  const indicated = glidingIndicator || motion === "motion";
  const trigger = (
    <Tooltip.Trigger
      payload={shortcut === undefined ? label : withShortcut(label, shortcut)}
      type="button"
      aria-current={current ? "page" : undefined}
      onClick={onClick}
      {...stylex.props(
        styles.navItem,
        current && (indicated ? styles.navItemCurrentIndicated : styles.navItemCurrent),
        style,
      )}
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
  if (motion !== "motion") return trigger;
  // The row clips its label, so the shared highlight sits beside the row instead of inside it,
  // where the clip would hide it mid-glide.
  return (
    <div {...stylex.props(styles.motionRow)}>
      {current && (
        <m.div
          layoutId="nav-indicator"
          transition={{ duration: 0.2, ease: motionEase }}
          {...stylex.props(styles.motionIndicator)}
        />
      )}
      {trigger}
    </div>
  );
}

// One highlight glides between rows. Each nav list mounts its own, so swapping lists between
// the app and Settings places it without gliding.
function NavIndicator({ current }: { current: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  useLayoutEffect(() => {
    const indicator = ref.current;
    const row = indicator?.parentElement?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!indicator || !row) return;
    if (!placed.current) indicator.style.transition = "none";
    indicator.style.transform = `translateY(${row.offsetTop}px)`;
    if (!placed.current) {
      indicator.getBoundingClientRect();
      indicator.style.transition = "";
      placed.current = true;
    }
  }, [current]);
  return <div ref={ref} aria-hidden="true" {...stylex.props(styles.indicator)} />;
}

function Nav<Id extends string>(props: {
  label: string;
  groups: readonly (readonly { id: Id; label: string; icon: LucideIcon }[])[];
  current: Id;
  collapsed: boolean;
  showShortcut: boolean;
  onSelect: (id: Id) => void;
}) {
  return (
    <nav
      aria-label={props.label}
      data-vt="nav"
      {...stylex.props(styles.nav, glidingIndicator && styles.navWithIndicator)}
    >
      {glidingIndicator && motion !== "motion" && <NavIndicator current={props.current} />}
      <NavItems {...props} />
    </nav>
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
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(null);
  const [lastChange, setLastChange] = useState<PageChange>("down");
  const motionCustom: MotionCustom = { change: lastChange, instant: useReducedMotion() === true };
  const page = settingsPage ?? appPage;
  // The page the user last asked for. A view transition commits a frame later, so direction
  // and rapid repeats read this instead of the rendered state.
  const intent = useRef<PageTarget>({ app: appPage, settings: settingsPage });
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
    if (accountKind === "error") {
      setSettingsPage("account");
      intent.current = { ...intent.current, settings: "account" };
    }
  }
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(sidebarCollapsedKey) === "true",
  );

  function toggleSidebar() {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(sidebarCollapsedKey, String(next));
  }

  function navigate(target: PageTarget) {
    const from = intent.current;
    if (from.app === target.app && from.settings === target.settings) {
      focusMain();
      return;
    }
    intent.current = target;
    const change = pageChange(from, target);
    commitPageChange(change, () => {
      setLastChange(change);
      setAppPage(target.app);
      setSettingsPage(target.settings);
      focusMain();
    });
  }

  function selectAppPage(id: AppPage) {
    navigate({ app: id, settings: null });
  }

  function selectSettingsPage(id: SettingsPage) {
    navigate({ app: intent.current.app, settings: id });
  }

  function closeSettings() {
    navigate({ app: intent.current.app, settings: null });
  }

  // Jump shortcuts resolve against the latest intent, since a pending view transition has not
  // yet re-rendered the bindings for the list the user just opened.
  const navTargets = Array.from(
    { length: Math.max(appPages.length, settingsPages.length) },
    (_, index) => () => {
      if (intent.current.settings === null) {
        const target = appPages[index];
        if (target) selectAppPage(target.id);
      } else {
        const target = settingsPages[index];
        if (target) selectSettingsPage(target.id);
      }
    },
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
  const pageColumn = (
    <div {...stylex.props(styles.column, page === "home" && styles.homeColumn)}>
      <Page snapshot={snapshot} history={history} openPage={selectAppPage} />
    </div>
  );
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">
        <div {...stylex.props(styles.shell)}>
          <div
            {...stylex.props(styles.titlebar, styles.titlebarGeometry(snapshot.settings.zoomLevel))}
          >
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
              {...stylex.props(
                styles.sidebar,
                collapsed && styles.sidebarCollapsed,
                motion === "motion" && styles.positioned,
              )}
            >
              <p {...stylex.props(styles.brand)}>
                <img src={iconUrl} alt="" draggable={false} {...stylex.props(styles.brandIcon)} />
                <span {...stylex.props(styles.label, collapsed && styles.labelHidden)}>Voice</span>
              </p>
              {motion === "motion" ? (
                <AnimatePresence mode="popLayout" initial={false} custom={motionCustom}>
                  <m.div
                    key={settingsPage === null ? "app" : "settings"}
                    custom={motionCustom}
                    variants={motionNavVariants}
                    initial={motionCustom.instant ? false : "enter"}
                    animate="center"
                    exit="exit"
                  >
                    <LayoutGroup id={settingsPage === null ? "app" : "settings"}>
                      {settingsPage === null ? (
                        <Nav
                          label="Voice"
                          groups={appPageGroups}
                          current={appPage}
                          collapsed={collapsed}
                          showShortcut={showShortcut}
                          onSelect={selectAppPage}
                        />
                      ) : (
                        <Nav
                          label="Settings"
                          groups={settingsPageGroups}
                          current={settingsPage}
                          collapsed={collapsed}
                          showShortcut={showShortcut}
                          onSelect={selectSettingsPage}
                        />
                      )}
                    </LayoutGroup>
                  </m.div>
                </AnimatePresence>
              ) : settingsPage === null ? (
                <Nav
                  key="app"
                  label="Voice"
                  groups={appPageGroups}
                  current={appPage}
                  collapsed={collapsed}
                  showShortcut={showShortcut}
                  onSelect={selectAppPage}
                />
              ) : (
                <Nav
                  key="settings"
                  label="Settings"
                  groups={settingsPageGroups}
                  current={settingsPage}
                  collapsed={collapsed}
                  showShortcut={showShortcut}
                  onSelect={selectSettingsPage}
                />
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
          <main
            ref={mainRef}
            tabIndex={-1}
            data-vt="card"
            {...stylex.props(
              styles.main,
              page === "style" && styles.styleMain,
              motion === "motion" && styles.positioned,
            )}
          >
            {motion === "motion" ? (
              <AnimatePresence mode="popLayout" initial={false} custom={motionCustom}>
                <m.div
                  key={page}
                  custom={motionCustom}
                  variants={motionPageVariants}
                  initial={motionCustom.instant ? false : "enter"}
                  animate="center"
                  exit="exit"
                >
                  {pageColumn}
                </m.div>
              </AnimatePresence>
            ) : (
              // Full width of the card, so old and new view transition snapshots share a width.
              <div
                key={motion === "fade" ? page : undefined}
                data-vt="page"
                {...stylex.props(motion === "fade" && styles.pageEnter)}
              >
                {pageColumn}
              </div>
            )}
          </main>
        </div>
      </MotionConfig>
    </LazyMotion>
  );
}

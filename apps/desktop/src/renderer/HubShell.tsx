import { Dialog } from "@base-ui/react/dialog";
import { Tooltip } from "@base-ui/react/tooltip";
import * as stylex from "@stylexjs/stylex";
import {
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
  UsersIcon,
  WandSparklesIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import iconUrl from "../../build/icon.svg";
import type { Snapshot } from "../shared/api.ts";
import type { OpenMeetingRequest } from "../shared/meetings.ts";
import type { HistoryState } from "../shared/history.ts";
import { TITLEBAR_HEIGHT, trafficLightsInset } from "../shared/titlebar.ts";
import { AccountSettings } from "./Account.tsx";
import { DialogBackdrop, dialogStyles, transitionHidden } from "./ConfirmDialog.tsx";
import { Dictionary } from "./Dictionary.tsx";
import { Home } from "./Home.tsx";
import { Insights } from "./Insights.tsx";
import { Meetings } from "./Meetings.tsx";
import { pageMotion } from "./pageMotion.ts";
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
  useMeetingShortcut,
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
import { hubApi } from "./voice.ts";
import { color, font, radius, space } from "./tokens.stylex.ts";
import { tooltipPopupClass, tooltipPositionerClass } from "./tooltip.ts";

const appPageGroups = [
  [
    { id: "home", label: "Home", icon: HouseIcon },
    { id: "meetings", label: "Meetings", icon: UsersIcon },
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
const widePages: ReadonlySet<AppPage> = new Set(["meetings"]);
const settingsPages = settingsPageGroups.flat();

export type AppPage = (typeof appPages)[number]["id"];
type SettingsPage = (typeof settingsPages)[number]["id"];

type PageView = {
  snapshot: Snapshot;
  history: HistoryState;
  openPage: (id: AppPage) => void;
  openSettingsPage: (id: SettingsPage) => void;
  /** The Meetings page's own settings dialog, which Settings can open too. */
  meetingSettings: { open: boolean; setOpen: (open: boolean) => void };
  /** The meeting main last asked to show; a new object each time it asks. */
  openMeeting: OpenMeetingRequest | null;
};

const appPageViews: Record<AppPage, (view: PageView) => ReactNode> = {
  home: ({ snapshot, history, openPage }) => (
    <Home snapshot={snapshot} history={history} onOpenInsights={() => openPage("insights")} />
  ),
  meetings: ({ snapshot, meetingSettings, openMeeting }) => (
    <Meetings snapshot={snapshot} settings={meetingSettings} request={openMeeting} />
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
};

const settingsPageViews: Record<SettingsPage, (view: PageView) => ReactNode> = {
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
  privacy: ({ snapshot, history, openPage, meetingSettings }) => (
    <DataPrivacySettings
      settings={snapshot.settings}
      history={history}
      onOpenMeetingSettings={() => {
        openPage("meetings");
        meetingSettings.setOpen(true);
      }}
    />
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
const navGap = 2;
const navDividerHeight = 1;
const railWidth = navItemSize + 2 * sidebarPadding;
const settingsMargin = 16;

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
  // Without isolation the highlight shows only while the nav's entrance animation runs, then
  // drops behind the sidebar background.
  nav: {
    position: "relative",
    isolation: "isolate",
    display: "flex",
    flexDirection: "column",
    gap: navGap,
    // Transform, not top, so the glide runs on the compositor while the new page renders.
    "::after": {
      content: "''",
      position: "absolute",
      top: 0,
      insetInline: 0,
      zIndex: -1,
      height: navItemSize,
      borderRadius: radius.small,
      backgroundColor: color.sidebarRowSelected,
      transform: `translateY(calc(var(--nav-row) * ${navItemSize + navGap}px + var(--nav-dividers) * (${navGap + navDividerHeight}px + 2 * ${space.sm})))`,
      transitionProperty: "transform",
      transitionDuration: { default: "var(--page-animation)", [reducedMotion]: "0s" },
      transitionTimingFunction: easing,
    },
  },
  navHighlightAt: (row: number, dividers: number) => ({
    "--nav-row": row,
    "--nav-dividers": dividers,
  }),
  navDivider: {
    flexShrink: 0,
    height: navDividerHeight,
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
    backgroundColor: { default: "transparent", ":hover": "transparent" },
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
  // Meetings sets its list beside an overview panel.
  columnWide: { maxWidth: 1120 },
  settingsViewport: {
    position: "fixed",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    paddingInline: settingsMargin,
    paddingBottom: settingsMargin,
  },
  // Dynamic because StyleX reads imported constants only from .stylex files, and main shares
  // TITLEBAR_HEIGHT.
  belowTitlebar: (titlebarHeight: number) => ({ paddingTop: titlebarHeight }),
  settingsPopup: {
    display: "flex",
    width: "100%",
    height: "100%",
    maxWidth: 1100,
    maxHeight: 780,
    overflow: "hidden",
    backgroundColor: color.background,
    fontSize: 14,
    lineHeight: 1.45,
    transitionDuration: { default: "var(--page-animation)", [reducedMotion]: "0s" },
  },
  settingsPopupHidden: { transform: "scale(0.96)" },
  settingsNav: {
    flexShrink: 0,
    width: sidebarWidth,
    overflowY: "auto",
    paddingBlock: space.lg,
    paddingInline: sidebarPadding,
    backgroundColor: color.sidebar,
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: color.border,
  },
  settingsTitle: {
    margin: 0,
    paddingInline: (navItemSize - navIconSize) / 2,
    paddingBottom: space.lg,
    fontFamily: font.serif,
    fontSize: 20,
    fontWeight: 500,
  },
  settingsContent: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" },
  settingsHeader: { display: "flex", justifyContent: "flex-end", padding: space.md },
  settingsScroller: {
    flex: 1,
    overflow: "auto",
    paddingInline: space.xl,
    paddingBottom: space.xxl,
  },
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
  current,
  collapsed,
  showShortcut,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  shortcut: Shortcut | undefined;
  current: boolean;
  collapsed: boolean;
  showShortcut: boolean;
  onClick: () => void;
}) {
  const showHint = showShortcut && shortcut !== undefined;
  return (
    <Tooltip.Trigger
      payload={shortcut === undefined ? label : withShortcut(label, shortcut)}
      type="button"
      aria-current={current ? "page" : undefined}
      onClick={onClick}
      {...stylex.props(styles.navItem, current && styles.navItemCurrent)}
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

function navHighlightAt<Id extends string>(
  groups: readonly (readonly { id: Id }[])[],
  current: Id,
) {
  return styles.navHighlightAt(
    groups.flat().findIndex(({ id }) => id === current),
    groups.findIndex((items) => items.some(({ id }) => id === current)),
  );
}

type SettingsModalState = { open: boolean; section: SettingsPage };

function jumpBindings<Id extends string>(
  pages: readonly { id: Id }[],
  select: (id: Id) => void,
): Binding[] {
  return pages.flatMap(({ id }, index): Binding[] => {
    const shortcut = jumpShortcuts[index];
    return shortcut ? [{ shortcut, run: () => select(id) }] : [];
  });
}

function SettingsModal({
  state,
  view,
  commandHeld,
  onClose,
  onClosed,
}: {
  state: SettingsModalState;
  view: PageView;
  commandHeld: boolean;
  onClose: () => void;
  onClosed: () => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 });
    scrollerRef.current?.focus({ preventScroll: true });
  }, [state.section]);
  const SectionView = settingsPageViews[state.section];
  return (
    <Dialog.Root
      open={state.open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) onClosed();
      }}
    >
      <Dialog.Portal>
        <DialogBackdrop />
        <Dialog.Viewport
          {...stylex.props(
            styles.settingsViewport,
            styles.belowTitlebar(TITLEBAR_HEIGHT),
            // The portal leaves the shell, so the modal sets the Page animations duration again.
            styles.pageAnimation(view.snapshot.settings.pageAnimationMs),
          )}
        >
          <Dialog.Popup
            data-app-modal
            initialFocus={scrollerRef}
            // Base UI swaps a non-tabbable return target, even a ref, for its first tabbable child,
            // so onClosed focuses main.
            finalFocus={false}
            className={({ transitionStatus }) =>
              stylex.props(
                dialogStyles.surface,
                styles.settingsPopup,
                transitionHidden(transitionStatus) && [
                  dialogStyles.surfaceHidden,
                  styles.settingsPopupHidden,
                ],
              ).className
            }
          >
            <div {...stylex.props(styles.settingsNav)}>
              <Dialog.Title {...stylex.props(styles.settingsTitle)}>Settings</Dialog.Title>
              {/* NavItem's tooltip trigger needs a root. It shows tooltips only when collapsed. */}
              <SidebarTooltip collapsed={false}>
                <nav
                  aria-label="Settings"
                  {...stylex.props(styles.nav, navHighlightAt(settingsPageGroups, state.section))}
                >
                  <NavItems
                    groups={settingsPageGroups}
                    current={state.section}
                    collapsed={false}
                    showShortcut={commandHeld}
                    onSelect={view.openSettingsPage}
                  />
                </nav>
              </SidebarTooltip>
            </div>
            <div {...stylex.props(styles.settingsContent)}>
              <div {...stylex.props(styles.settingsHeader)}>
                <Dialog.Close
                  aria-label="Close settings"
                  title="Close settings"
                  {...stylex.props(titlebar.button)}
                >
                  <XIcon size={navIconSize} />
                </Dialog.Close>
              </div>
              <div ref={scrollerRef} tabIndex={-1} {...stylex.props(styles.settingsScroller)}>
                <div {...stylex.props(styles.column)}>
                  <SectionView {...view} />
                </div>
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function HubShell({
  snapshot,
  history,
  initialPage = "home",
}: {
  snapshot: Snapshot;
  history: HistoryState;
  /** The preview harness opens a scene's page directly. */
  initialPage?: AppPage;
}) {
  const [appPage, setAppPage] = useState<AppPage>(initialPage);
  const [settings, setSettings] = useState<SettingsModalState>({
    open: false,
    section: "general",
  });
  const openSettings = (section: SettingsPage) => setSettings({ open: true, section });
  const [meetingSettingsOpen, setMeetingSettingsOpen] = useState(false);
  const [openMeeting, setOpenMeeting] = useState<OpenMeetingRequest | null>(null);
  useEffect(
    () =>
      hubApi().onOpenMeeting((request) => {
        setAppPage("meetings");
        setSettings((current) => ({ ...current, open: false }));
        setOpenMeeting({ ...request });
      }),
    [],
  );
  const closeSettings = () => setSettings((current) => ({ ...current, open: false }));
  const [shown, setShown] = useState({ page: appPage, rises: false });
  if (shown.page !== appPage) setShown({ page: appPage, rises: true });
  const mainRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [appPage]);
  // The card is the only scroller, and PageDown or Space only scroll a focused scroller.
  const focusMain = () => mainRef.current?.focus({ preventScroll: true });
  useEffect(focusMain, []);
  // A sign-in error can arrive from the browser while another page shows, or before the hub
  // opens, as when the browser finishes a sign-in that a quit cut short.
  const accountKind = snapshot.account.kind;
  const [shownAccountKind, setShownAccountKind] = useState<typeof accountKind | null>(null);
  if (accountKind !== shownAccountKind) {
    setShownAccountKind(accountKind);
    if (accountKind === "error") openSettings("account");
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
    closeSettings();
    focusMain();
  }

  useShortcuts(
    settings.open
      ? [
          { shortcut: shortcuts.openSettings, run: closeSettings },
          ...jumpBindings(settingsPages, openSettings),
        ]
      : [
          { shortcut: shortcuts.toggleSidebar, run: toggleSidebar },
          { shortcut: shortcuts.openSettings, run: () => openSettings("general") },
          ...jumpBindings(appPages, selectAppPage),
        ],
    { reachAppModal: true },
  );
  useMeetingShortcut(snapshot.settings.meetingShortcut, () => void hubApi().toggleMeeting());
  const commandHeld = useCommandHeld(snapshot.settings);

  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";
  const settingsLabel = withShortcut("Settings", shortcuts.openSettings);
  const view: PageView = {
    snapshot,
    history,
    openPage: selectAppPage,
    openSettingsPage: openSettings,
    meetingSettings: { open: meetingSettingsOpen, setOpen: setMeetingSettingsOpen },
    openMeeting,
  };
  const AppPageView = appPageViews[appPage];
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
        <TitlebarAccount account={snapshot.account} onOpenAccount={() => openSettings("account")} />
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
          <nav
            aria-label="Voice"
            {...stylex.props(styles.nav, navHighlightAt(appPageGroups, appPage))}
          >
            <NavItems
              groups={appPageGroups}
              current={appPage}
              collapsed={collapsed}
              showShortcut={commandHeld && !collapsed && !settings.open}
              onSelect={selectAppPage}
            />
          </nav>
          <div {...stylex.props(styles.footer)}>
            <Tooltip.Trigger
              payload={settingsLabel}
              type="button"
              aria-label="Settings"
              title={collapsed ? undefined : settingsLabel}
              onClick={() => openSettings("general")}
              {...stylex.props(styles.navItem, styles.footerButton)}
            >
              <SlidersHorizontalIcon size={navIconSize} />
            </Tooltip.Trigger>
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
        <div
          key={appPage}
          {...stylex.props(
            styles.column,
            widePages.has(appPage) && styles.columnWide,
            shown.rises && pageMotion.rise,
          )}
        >
          <AppPageView {...view} />
        </div>
      </main>
      <SettingsModal
        state={settings}
        view={view}
        commandHeld={commandHeld}
        onClose={closeSettings}
        onClosed={focusMain}
      />
    </div>
  );
}

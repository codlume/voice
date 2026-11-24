import { Dialog } from "@base-ui/react/dialog";
import * as stylex from "@stylexjs/stylex";
import {
  BookAIcon,
  BoxIcon,
  ChartColumnIcon,
  HouseIcon,
  KeyboardIcon,
  MonitorIcon,
  PanelLeftCloseIcon,
  PanelLeftIcon,
  PenLineIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  TextQuoteIcon,
  UserIcon,
  UsersIcon,
  WandSparklesIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import iconUrl from "../../build/icon.svg";
import type { Snapshot } from "../shared/api.ts";
import type { OpenMeetingRequest } from "../shared/meetings.ts";
import type { HistoryState } from "../shared/history.ts";
import { TITLEBAR_HEIGHT, trafficLightsInset } from "../shared/titlebar.ts";
import { AccountSettings } from "./Account.tsx";
import { Badge } from "./Badge.tsx";
import { DialogBackdrop, dialogStyles, transitionHidden } from "./ConfirmDialog.tsx";
import { DataPrivacySettings } from "./DataPrivacySettings.tsx";
import { Dictionary } from "./Dictionary.tsx";
import { GeneralSettings } from "./GeneralSettings.tsx";
import { Home } from "./Home.tsx";
import { Insights } from "./Insights.tsx";
import { Keycap } from "./Keycap.tsx";
import { helpFor } from "./help.ts";
import { HelpContext, helpClosed, HelpPopover, type HelpState } from "./HelpPopover.tsx";
import { Meetings } from "./Meetings.tsx";
import { ModelsSettings } from "./ModelsSettings.tsx";
import { pageMotion } from "./pageMotion.ts";
import { NavigationHold } from "./navigationHold.ts";
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
import { ShortcutsSettings } from "./ShortcutsSettings.tsx";
import { Skeleton } from "./Skeleton.tsx";
import { Snippets } from "./Snippets.tsx";
import { Style } from "./Style.tsx";
import { SystemSettings } from "./SystemSettings.tsx";
import { Transforms } from "./Transforms.tsx";
import { titlebar } from "./titlebar.ts";
import { TitlebarAccount } from "./TitlebarAccount.tsx";
import { RestartNotice } from "./RestartNotice.tsx";
import { SidebarUpdates } from "./Updates.tsx";
import { hubApi } from "./voice.ts";
import { color, elevation, font, leading, motion, radius, space, text } from "./tokens.stylex.ts";

const appPageGroups = [
  [
    { id: "home", label: "Home", icon: HouseIcon },
    { id: "meetings", label: "Meetings", icon: UsersIcon, badge: "Beta" },
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
  meetingSettings: { open: boolean; setOpen: (open: boolean) => void };
  /** The meeting main asked to show, until the user leaves Meetings; a new object each time. */
  openMeeting: OpenMeetingRequest | null;
  /** Where a page can put a card under the nav; null while the sidebar is collapsed. */
  sidebar: HTMLElement | null;
};

const appPageViews: Record<AppPage, (view: PageView) => ReactNode> = {
  home: ({ snapshot, history, openPage }) => (
    <Home snapshot={snapshot} history={history} onOpenInsights={() => openPage("insights")} />
  ),
  meetings: ({ snapshot, meetingSettings, openMeeting, sidebar }) => (
    <Meetings
      snapshot={snapshot}
      settings={meetingSettings}
      request={openMeeting}
      sidebar={sidebar}
    />
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

// The sidebar, rows and Settings frame follow an adapted app shell (MIT, see THIRD_PARTY_NOTICES.md).
const sidebarWidth = 256;
const sidebarInset = 8;
const navItemSize = 32;
const navIconSize = 16;
const navGap = 4;
const navDividerHeight = 1;
const titlebarControlSize = 28;

const brandIconVisibleSize = 16;
const macIconGridMargin = 100 / 1024;
const brandIconSize = brandIconVisibleSize / (1 - 2 * macIconGridMargin);

const dark = "@media (prefers-color-scheme: dark)";
const wide = "@media (min-width: 1024px)";

const styles = stylex.create({
  shell: {
    display: "grid",
    gridTemplateRows: "auto 1fr auto",
    gridTemplateColumns: "auto 1fr",
    height: "100vh",
    backgroundColor: color.sidebar,
    color: color.foreground,
    fontFamily: font.sans,
    fontSize: text.sm,
    lineHeight: leading.sm,
    WebkitFontSmoothing: "antialiased",
  },
  titlebar: {
    gridColumn: "1 / -1",
    display: "flex",
    alignItems: "center",
    paddingRight: space.md,
    WebkitAppRegion: "drag",
  },
  pageAnimation: (ms: number) => ({ "--page-animation": `${ms}ms` }),
  titlebarGeometry: (zoomLevel: number) => ({
    height: TITLEBAR_HEIGHT,
    paddingLeft: trafficLightsInset(zoomLevel),
  }),
  brand: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    margin: 0,
    marginLeft: space.md,
    fontWeight: 500,
    letterSpacing: "-0.01em",
    transitionProperty: "opacity, visibility",
    transitionDuration: { default: "var(--page-animation)", [motion.reduced]: "0s" },
    transitionTimingFunction: motion.drawer,
  },
  brandHidden: { opacity: 0, visibility: "hidden" },
  brandIcon: {
    flexShrink: 0,
    width: brandIconSize,
    height: brandIconSize,
    margin: -(brandIconSize - brandIconVisibleSize) / 2,
  },
  toggleSpacer: { flexShrink: 0, width: titlebarControlSize },
  accountSlot: { marginLeft: "auto" },
  // Collapsing slides the sidebar off the canvas; its content keeps its width so nothing reflows.
  sidebar: {
    gridRow: "2 / -1",
    width: sidebarWidth,
    overflow: "hidden",
    transitionProperty: "width",
    transitionDuration: { default: "var(--page-animation)", [motion.reduced]: "0s" },
    transitionTimingFunction: motion.drawer,
  },
  sidebarCollapsed: { width: 0 },
  sidebarContent: {
    display: "flex",
    flexDirection: "column",
    width: sidebarWidth,
    height: "100%",
    padding: sidebarInset,
    paddingTop: 0,
    whiteSpace: "nowrap",
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
      borderRadius: radius.medium,
      backgroundColor: color.sidebarRowSelected,
      transform: `translateY(calc(var(--nav-row) * ${navItemSize + navGap}px + var(--nav-dividers) * (${navGap + navDividerHeight}px + 2 * ${space.sm})))`,
      transitionProperty: "transform",
      transitionDuration: { default: "var(--page-animation)", [motion.reduced]: "0s" },
      transitionTimingFunction: motion.drawer,
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
    marginInline: 10,
    backgroundColor: color.border,
  },
  navItem: {
    "--nav-icon": {
      default: `color-mix(in srgb, ${color.mutedForeground} 85%, ${color.sidebar})`,
      ":hover": color.foreground,
    },
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    flexShrink: 0,
    width: "100%",
    height: navItemSize,
    paddingBlock: 6,
    paddingInline: 10,
    borderWidth: 0,
    borderRadius: radius.medium,
    backgroundColor: { default: "transparent", ":hover": color.sidebarRowHover },
    color: {
      default: `color-mix(in srgb, ${color.mutedForeground} 80%, transparent)`,
      ":hover": color.foreground,
    },
    fontFamily: "inherit",
    fontSize: text.sm,
    fontWeight: 500,
    lineHeight: leading.sm,
    textAlign: "left",
    cursor: "pointer",
  },
  navItemCurrent: {
    "--nav-icon": color.foreground,
    backgroundColor: { default: "transparent", ":hover": "transparent" },
    color: color.foreground,
  },
  icon: { flexShrink: 0, color: "var(--nav-icon)" },
  label: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
  trailing: { display: "flex", flexShrink: 0, marginLeft: "auto" },
  footer: {
    display: "flex",
    flexDirection: "column",
    gap: navGap,
    marginTop: "auto",
    paddingTop: space.xxs,
  },
  main: {
    gridColumn: "2",
    gridRow: "2",
    minWidth: 0,
    overflow: "auto",
    marginRight: sidebarInset,
    marginBottom: sidebarInset,
    paddingBlock: space.xxl,
    paddingInline: space.xxl,
    backgroundColor: { default: color.card, [dark]: color.background },
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: {
      default: `color-mix(in srgb, ${color.border} 60%, transparent)`,
      [dark]: color.border,
    },
    borderRadius: radius.large,
    boxShadow: { default: elevation.sm, [dark]: "none" },
    transitionProperty: "margin-left",
    transitionDuration: { default: "var(--page-animation)", [motion.reduced]: "0s" },
    transitionTimingFunction: motion.drawer,
  },
  mainBesideCollapsed: { marginLeft: sidebarInset },
  mainWide: { paddingBlock: 0, paddingRight: 0, containerType: "size" },
  column: { maxWidth: 800, marginInline: "auto" },
  columnWide: { maxWidth: 1120 },
  sidebarSlot: { marginTop: space.lg },
  skeletonNav: { display: "flex", flexDirection: "column", gap: navGap },
  skeletonRow: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: navItemSize,
    paddingInline: 10,
  },
  skeletonPage: { display: "flex", flexDirection: "column", gap: space.base },
  skeletonHeadline: { paddingBottom: space.base },
  settingsViewport: {
    position: "fixed",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    paddingInline: { default: 24, [wide]: 40 },
    paddingBottom: { default: 24, [wide]: 40 },
  },
  // Dynamic because StyleX reads imported constants only from .stylex files, and main shares
  // TITLEBAR_HEIGHT.
  belowTitlebar: (titlebarHeight: number) => ({ paddingTop: titlebarHeight }),
  // Settings is a full page, so it stays opaque instead of frosted.
  settingsPopup: {
    display: "flex",
    width: "100%",
    height: "100%",
    maxWidth: 1280,
    maxHeight: 960,
    overflow: "hidden",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.xl,
    backgroundColor: color.background,
    boxShadow: "0 25px 50px -12px rgb(0 0 0 / 40%)",
    color: color.foreground,
    fontFamily: font.sans,
    fontSize: text.sm,
    lineHeight: leading.sm,
    WebkitFontSmoothing: "antialiased",
    outline: "none",
    transitionDuration: { default: motion.base, [motion.reduced]: "0s" },
    transitionTimingFunction: motion.easeOut,
  },
  settingsPopupHidden: { transform: "scale(0.985)" },
  settingsNav: {
    flexShrink: 0,
    width: 240,
    overflowY: "auto",
    padding: sidebarInset,
    backgroundColor: { default: color.sidebar, [dark]: color.card },
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: color.border,
  },
  settingsContent: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" },
  settingsHeader: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    flexShrink: 0,
    height: 48,
    paddingLeft: space.lg,
    paddingRight: space.sm,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: color.border,
  },
  breadcrumb: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    fontSize: text.sm,
    fontWeight: 500,
    lineHeight: leading.sm,
  },
  breadcrumbParent: { color: color.mutedForeground },
  settingsScroller: {
    flex: 1,
    overflow: "auto",
    paddingInline: space.xl,
    paddingTop: space.xl,
    paddingBottom: space.xxl,
  },
});

function NavItem({
  label,
  icon: Icon,
  badge,
  shortcut,
  current,
  showShortcut,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  badge: string | undefined;
  shortcut: Shortcut | undefined;
  current: boolean;
  showShortcut: boolean;
  onClick: () => void;
}) {
  const showHint = showShortcut && shortcut !== undefined;
  return (
    <button
      type="button"
      aria-label={badge === undefined ? undefined : `${label}, ${badge}`}
      aria-current={current ? "page" : undefined}
      onClick={onClick}
      {...stylex.props(styles.navItem, current && styles.navItemCurrent)}
    >
      <Icon size={navIconSize} {...stylex.props(styles.icon)} />
      <span {...stylex.props(styles.label)}>{label}</span>
      {showHint ? (
        <span aria-hidden="true" {...stylex.props(styles.trailing)}>
          <Keycap>{shortcut.hint}</Keycap>
        </span>
      ) : (
        badge !== undefined && (
          <span {...stylex.props(styles.trailing)}>
            <Badge>{badge}</Badge>
          </span>
        )
      )}
    </button>
  );
}

function NavItems<Id extends string>({
  groups,
  current,
  showShortcut,
  onSelect,
}: {
  groups: readonly (readonly { id: Id; label: string; icon: LucideIcon; badge?: string }[])[];
  current: Id;
  showShortcut: boolean;
  onSelect: (id: Id) => void;
}) {
  let index = 0;
  return groups.map((items, groupIndex) => (
    <Fragment key={items[0]?.id}>
      {groupIndex > 0 && <hr {...stylex.props(styles.navDivider)} />}
      {items.map(({ id, label, icon, badge }) => (
        <NavItem
          key={id}
          label={label}
          icon={icon}
          badge={badge}
          shortcut={jumpShortcuts[index++]}
          current={current === id}
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

const readCollapsed = () => localStorage.getItem(sidebarCollapsedKey) === "true";

function Brand({ hidden }: { hidden: boolean }) {
  return (
    <p {...stylex.props(styles.brand, hidden && styles.brandHidden)}>
      <img src={iconUrl} alt="" draggable={false} {...stylex.props(styles.brandIcon)} />
      Voice
    </p>
  );
}

function Titlebar({ zoomLevel, children }: { zoomLevel: number; children: ReactNode }) {
  return (
    <div data-drag-region {...stylex.props(styles.titlebar, styles.titlebarGeometry(zoomLevel))}>
      {children}
    </div>
  );
}

/** What the Voice window draws until the first snapshot and history arrive. */
export function HubShellSkeleton({ collapsed = readCollapsed() }: { collapsed?: boolean }) {
  return (
    <div {...stylex.props(styles.shell)}>
      <Titlebar zoomLevel={0}>
        <span {...stylex.props(styles.toggleSpacer)} />
        <Brand hidden={collapsed} />
      </Titlebar>
      <div {...stylex.props(styles.sidebar, collapsed && styles.sidebarCollapsed)}>
        <div {...stylex.props(styles.sidebarContent)}>
          <div {...stylex.props(styles.skeletonNav)}>
            {appPages.map(({ id, label }) => (
              <span key={id} {...stylex.props(styles.skeletonRow)}>
                <Skeleton width={`${navIconSize}px`} height={`${navIconSize}px`} />
                <Skeleton width={`${label.length * 7 + 16}px`} height="12px" />
              </span>
            ))}
          </div>
          <div {...stylex.props(styles.footer)}>
            <span {...stylex.props(styles.skeletonRow)}>
              <Skeleton width={`${navIconSize}px`} height={`${navIconSize}px`} />
              <Skeleton width="64px" height="12px" />
            </span>
          </div>
        </div>
      </div>
      <main
        aria-busy="true"
        aria-label="Loading"
        {...stylex.props(styles.main, collapsed && styles.mainBesideCollapsed)}
      >
        <div {...stylex.props(styles.column, styles.skeletonPage)}>
          <div {...stylex.props(styles.skeletonHeadline)}>
            <Skeleton width="40%" height="32px" />
          </div>
          <Skeleton width="64%" height="14px" />
          <Skeleton shape="card" height="120px" />
          <Skeleton shape="card" height="56px" />
          <Skeleton shape="card" height="56px" />
          <Skeleton shape="card" height="56px" />
        </div>
      </main>
    </div>
  );
}

type SettingsModalState = { open: boolean; section: SettingsPage };

const sectionLabel = (id: SettingsPage) =>
  settingsPages.find((page) => page.id === id)?.label ?? "";

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
    // eslint-disable-next-line react/exhaustive-effect-dependencies
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
              <nav
                aria-label="Settings"
                {...stylex.props(styles.nav, navHighlightAt(settingsPageGroups, state.section))}
              >
                <NavItems
                  groups={settingsPageGroups}
                  current={state.section}
                  showShortcut={commandHeld}
                  onSelect={view.openSettingsPage}
                />
              </nav>
            </div>
            <div {...stylex.props(styles.settingsContent)}>
              <div {...stylex.props(styles.settingsHeader)}>
                <Dialog.Title render={<h2 />} {...stylex.props(styles.breadcrumb)}>
                  <span {...stylex.props(styles.breadcrumbParent)}>Settings</span>
                  <span aria-hidden="true" {...stylex.props(styles.breadcrumbParent)}>
                    /
                  </span>
                  <span>{sectionLabel(state.section)}</span>
                </Dialog.Title>
                <Dialog.Close
                  aria-label="Close settings"
                  title="Close settings (Esc)"
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
  initialPage?: AppPage;
}) {
  const [appPage, setAppPage] = useState<AppPage>(initialPage);
  const [settings, setSettings] = useState<SettingsModalState>({
    open: false,
    section: "general",
  });
  const [help, setHelp] = useState<HelpState>(helpClosed);
  const [helpButtonOn, setHelpButtonOn] = useState<{
    element: HTMLButtonElement | null;
    page: AppPage;
  } | null>(null);
  const helpButton = helpButtonOn?.element ?? null;
  const placeHelpButton = useCallback(
    (element: HTMLButtonElement | null, page: AppPage) =>
      setHelpButtonOn((current) =>
        element ? { element, page } : current && { element: null, page: current.page },
      ),
    [],
  );
  const openSettings = (section: SettingsPage) => {
    setSettings({ open: true, section });
    setHelp(helpClosed);
  };
  const [meetingSettingsOpen, setMeetingSettingsOpen] = useState(false);
  const [openMeeting, setOpenMeeting] = useState<OpenMeetingRequest | null>(null);
  const [askedMeeting, setAskedMeeting] = useState<OpenMeetingRequest | null>(null);
  useEffect(() => hubApi().onOpenMeeting((request) => setAskedMeeting({ ...request })), []);
  const [holds, setHolds] = useState(0);
  const holdNavigation = useCallback(() => {
    setHolds((count) => count + 1);
    return () => setHolds((count) => count - 1);
  }, []);
  if (askedMeeting !== null && holds === 0) {
    setAskedMeeting(null);
    setAppPage("meetings");
    setSettings((current) => ({ ...current, open: false }));
    setOpenMeeting(askedMeeting);
  }
  const [sidebarSlot, setSidebarSlot] = useState<HTMLDivElement | null>(null);
  const closeSettings = () => setSettings((current) => ({ ...current, open: false }));
  const [shown, setShown] = useState({ page: appPage, rises: false });
  if (shown.page !== appPage) {
    setShown({ page: appPage, rises: true });
    if (help.kind !== "closed") setHelp(helpFor(appPage) ? { kind: "list" } : helpClosed);
    if (appPage !== "meetings") setOpenMeeting(null);
  }
  if (help.kind !== "closed" && helpButton === null && helpButtonOn?.page === appPage) {
    setHelp(helpClosed);
  }
  const toggleHelp = () =>
    setHelp((current) => (current.kind === "closed" ? { kind: "list" } : helpClosed));
  const mainRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    // eslint-disable-next-line react/exhaustive-effect-dependencies
  }, [appPage]);
  // The card is the only scroller, and PageDown or Space only scroll a focused scroller.
  const focusMain = () => mainRef.current?.focus({ preventScroll: true });
  useEffect(focusMain, []);
  const accountKind = snapshot.account.kind;
  const [shownAccountKind, setShownAccountKind] = useState<typeof accountKind | null>(null);
  if (accountKind !== shownAccountKind) {
    setShownAccountKind(accountKind);
    if (accountKind === "error") openSettings("account");
  }
  const [collapsed, setCollapsed] = useState(readCollapsed);

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
          ...(helpButton ? [{ shortcut: shortcuts.help, run: toggleHelp }] : []),
          // eslint-disable-next-line react/refs
          ...jumpBindings(appPages, selectAppPage),
        ],
    { reachAppModal: true },
  );
  useMeetingShortcut(snapshot.settings.meetingShortcut, () => void hubApi().toggleMeeting());
  const commandHeld = useCommandHeld(snapshot.settings);

  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";
  const view: PageView = {
    snapshot,
    history,
    openPage: selectAppPage,
    openSettingsPage: openSettings,
    meetingSettings: { open: meetingSettingsOpen, setOpen: setMeetingSettingsOpen },
    openMeeting,
    sidebar: sidebarSlot,
  };
  const AppPageView = appPageViews[appPage];
  return (
    <div {...stylex.props(styles.shell, styles.pageAnimation(snapshot.settings.pageAnimationMs))}>
      <Titlebar zoomLevel={snapshot.settings.zoomLevel}>
        <button
          type="button"
          aria-label={toggleLabel}
          title={withShortcut(toggleLabel, shortcuts.toggleSidebar)}
          aria-expanded={!collapsed}
          aria-controls={sidebarId}
          onClick={toggleSidebar}
          {...stylex.props(titlebar.button)}
        >
          {collapsed ? (
            <PanelLeftIcon size={navIconSize} />
          ) : (
            <PanelLeftCloseIcon size={navIconSize} />
          )}
        </button>
        <Brand hidden={collapsed} />
        <div {...stylex.props(styles.accountSlot)}>
          <TitlebarAccount
            account={snapshot.account}
            onOpenAccount={() => openSettings("account")}
          />
        </div>
      </Titlebar>
      <aside
        id={sidebarId}
        inert={collapsed}
        {...stylex.props(styles.sidebar, collapsed && styles.sidebarCollapsed)}
      >
        <div {...stylex.props(styles.sidebarContent)}>
          <nav
            aria-label="Voice"
            {...stylex.props(styles.nav, navHighlightAt(appPageGroups, appPage))}
          >
            <NavItems
              groups={appPageGroups}
              current={appPage}
              showShortcut={commandHeld && !collapsed && !settings.open}
              onSelect={selectAppPage}
            />
          </nav>
          {!collapsed && <div ref={setSidebarSlot} {...stylex.props(styles.sidebarSlot)} />}
          <div {...stylex.props(styles.footer)}>
            <SidebarUpdates
              updates={snapshot.updates}
              session={snapshot.session}
              history={history}
              rowStyle={styles.navItem}
            />
            <button
              type="button"
              aria-label="Settings"
              onClick={() => openSettings("general")}
              {...stylex.props(styles.navItem)}
            >
              <SettingsIcon size={navIconSize} {...stylex.props(styles.icon)} />
              <span {...stylex.props(styles.label)}>Settings</span>
              <span aria-hidden="true" {...stylex.props(styles.trailing)}>
                <Keycap>{shortcuts.openSettings.hint}</Keycap>
              </span>
            </button>
          </div>
        </div>
      </aside>
      <main
        ref={mainRef}
        tabIndex={-1}
        {...stylex.props(
          styles.main,
          collapsed && styles.mainBesideCollapsed,
          widePages.has(appPage) && styles.mainWide,
        )}
      >
        <div
          key={appPage}
          {...stylex.props(
            styles.column,
            widePages.has(appPage) && styles.columnWide,
            shown.rises && pageMotion.rise,
          )}
        >
          <HelpContext
            value={{
              open: help.kind !== "closed",
              placeButton: placeHelpButton,
            }}
          >
            <NavigationHold value={holdNavigation}>
              <AppPageView {...view} />
            </NavigationHold>
          </HelpContext>
        </div>
      </main>
      <RestartNotice notice={snapshot.restartNotice} />
      <HelpPopover page={appPage} state={help} onChange={setHelp} button={helpButton} />
      <NavigationHold value={holdNavigation}>
        <SettingsModal
          state={settings}
          view={view}
          commandHeld={commandHeld}
          onClose={closeSettings}
          onClosed={focusMain}
        />
      </NavigationHold>
    </div>
  );
}

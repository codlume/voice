import { Tabs } from "@base-ui/react/tabs";
import { Tooltip } from "@base-ui/react/tooltip";
import * as stylex from "@stylexjs/stylex";
import {
  AudioLinesIcon,
  CircleAlertIcon,
  CircleDotIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { DayKey } from "../shared/insights.ts";
import { shownSummary } from "../shared/meeting-markdown.ts";
import {
  liveMeeting,
  titleText,
  type LiveMeeting,
  type Meeting,
  type MeetingId,
  type MeetingSearchHit,
  type MeetingsState,
  type OpenMeetingRequest,
} from "../shared/meetings.ts";
import type { Snapshot } from "../shared/api.ts";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { meetingsChecklist, summaryModelRow, type ChecklistRow } from "./checklist.ts";
import { EmptyState } from "./EmptyState.tsx";
import { SearchField } from "./Input.tsx";
import { runSetupCommand, setupFailure } from "./SetupChecklist.tsx";
import { MeetingDetail } from "./MeetingDetail.tsx";
import { MeetingFolders } from "./MeetingFolders.tsx";
import { MeetingList } from "./MeetingList.tsx";
import { MeetingNotices } from "./MeetingNotices.tsx";
import { MeetingTabs, RecordingControls, StatusClock } from "./MeetingParts.tsx";
import { MeetingsSettingsDialog } from "./MeetingsSettingsDialog.tsx";
import { MeetingsSetup } from "./MeetingsSetup.tsx";
import { Inline } from "./MeetingSummary.tsx";
import {
  CONSENT_REMINDER,
  meetingDays,
  meetingWhen,
  overview,
  searchResults,
  summaryNotice,
} from "./meetingsView.ts";
import { commandRefusal, statusView, type RecordingCommand } from "./meetingStatus.ts";
import { helpAnchor } from "./help.ts";
import { HelpTitle } from "./HelpPopover.tsx";
import { pageStyles } from "./pageStyles.ts";
import { shortcutLabel } from "./shortcutCapture.ts";
import { shortcuts, useShortcuts, withShortcut } from "./shortcuts.ts";
import { ProgressBar, Skeleton } from "./Skeleton.tsx";
import {
  color,
  font,
  layout,
  leading,
  motion,
  radius,
  space,
  text as size,
} from "./tokens.stylex.ts";
import { tooltipPopupClass, tooltipPositionerClass } from "./tooltip.ts";
import { useAction } from "./useAction.ts";
import { useKeyboardLayout } from "./useKeyboardLayout.ts";
import { useMeetingsRead } from "./useMeetings.ts";
import { useToday } from "./useToday.ts";
import { hubApi } from "./voice.ts";

const styles = stylex.create({
  container: { containerType: "inline-size" },
  layout: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr) 300px", [layout.narrow]: "minmax(0, 1fr)" },
    alignItems: "start",
  },
  layoutAlone: { gridTemplateColumns: "minmax(0, 1fr)" },
  main: {
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
    minWidth: 0,
    paddingBlock: space.xxl,
    paddingRight: { default: space.xl, [layout.narrow]: space.xxl },
  },
  mainAlone: { paddingRight: space.xxl },
  detail: { paddingBlock: space.xxl, paddingRight: space.xxl },
  header: { display: "flex", alignItems: "center", gap: space.sm, minHeight: 32 },
  headline: { flexGrow: 1 },
  notice: { margin: 0, color: color.mutedForeground, fontSize: size.xs, lineHeight: leading.xs },
  // A one-line notice: hairline border on the muted fill, its action at the right.
  modelNotice: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space.sm,
    rowGap: space.xxs,
    minHeight: 40,
    paddingBlock: space.xxs,
    paddingInlineStart: space.md,
    paddingInlineEnd: space.xxs,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.medium,
    backgroundColor: color.muted,
  },
  modelIcon: { flexShrink: 0, color: color.mutedForeground },
  modelText: { flexGrow: 1, minWidth: 0, margin: 0, fontSize: size.sm, lineHeight: leading.sm },
  modelStatus: {
    color: color.mutedForeground,
    fontSize: size.xs,
    lineHeight: leading.xs,
    fontVariantNumeric: "tabular-nums",
  },
  modelFailed: { color: color.errorForeground },
  modelProgress: { width: 96 },
  tabs: { display: "flex", flexDirection: "column", gap: space.lg },
  search: { display: "flex", width: 220, flexShrink: 0, marginInlineStart: "auto" },
  panel: {
    outline: { default: "none", ":focus-visible": `2px solid ${color["--ring"]}` },
    outlineOffset: 3,
  },
  live: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    paddingBlock: space.md,
    paddingInline: space.base,
  },
  dot: {
    flexShrink: 0,
    width: 8,
    height: 8,
    borderRadius: radius.round,
    backgroundColor: color.mutedForeground,
  },
  dotRecording: {
    backgroundColor: color.error,
    animationName: stylex.keyframes({ "50%": { opacity: 0.35 } }),
    animationDuration: { default: "1.6s", [motion.reduced]: "0s" },
    animationIterationCount: "infinite",
  },
  liveText: { display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0 },
  liveTitle: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: color.foreground,
    fontFamily: font.sans,
    fontSize: size.sm,
    fontWeight: 500,
    lineHeight: leading.sm,
    textAlign: "left",
    cursor: "pointer",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  liveMeta: {
    color: color.mutedForeground,
    fontSize: size.xs,
    lineHeight: leading.xs,
    fontVariantNumeric: "tabular-nums",
  },
  aside: {
    display: { default: "flex", [layout.narrow]: "none" },
    flexDirection: "column",
    gap: space.sm,
    position: "sticky",
    top: 0,
    height: "100cqh",
    overflowY: "auto",
    paddingBlock: space.xxl,
    paddingInline: space.xl,
    borderLeftWidth: 1,
    borderLeftStyle: "solid",
    borderLeftColor: color.border,
  },
  asideTitle: {
    margin: 0,
    fontSize: size.lg,
    fontWeight: 600,
    lineHeight: leading.lg,
    overflowWrap: "anywhere",
  },
  asideWhen: {
    margin: 0,
    color: color.mutedForeground,
    fontSize: size.sm,
    lineHeight: leading.sm,
    fontVariantNumeric: "tabular-nums",
  },
  asideRule: {
    width: "100%",
    height: 1,
    marginBlock: space.md,
    borderWidth: 0,
    backgroundColor: color.border,
  },
  overviewLabel: {
    margin: 0,
    color: color.mutedForeground,
    fontSize: size.xs,
    fontWeight: 500,
    lineHeight: leading.xs,
  },
  overview: { margin: 0, fontSize: size.sm, lineHeight: leading.sm },
  overviewEmpty: { margin: 0, color: color.mutedForeground, fontSize: size.sm },
  days: { display: "flex", flexDirection: "column", gap: space.lg },
  day: { display: "flex", flexDirection: "column", gap: space.sm },
  clip: { overflow: "hidden" },
  skeletonRow: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: space.xs,
    minHeight: 44,
    paddingBlock: space.sm,
    paddingInline: space.base,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: `color-mix(in srgb, ${color.border} 50%, transparent)`,
  },
});

const SEARCH_DELAY_MS = 150;

type SearchAnswer = readonly MeetingSearchHit[] | "failed";

function useSearch(query: string): SearchAnswer | null {
  const trimmed = query.trim();
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);
  if (trimmed === "" && answer !== null) setAnswer(null);
  useEffect(() => {
    if (trimmed === "") return;
    let current = true;
    const answered = (next: SearchAnswer) => {
      if (current) setAnswer(next);
    };
    const timer = setTimeout(() => {
      void hubApi()
        .searchMeetings(trimmed)
        .then(answered, () => answered("failed"));
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [trimmed]);
  return answer;
}

function Search({ query, onChange }: { query: string; onChange: (query: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  useShortcuts([
    {
      shortcut: shortcuts.searchHistory,
      run: () => {
        input.current?.focus();
        input.current?.select();
      },
    },
  ]);
  return (
    <span {...helpAnchor("meetings.search")} {...stylex.props(styles.search)}>
      <SearchField
        ref={input}
        aria-label="Search meetings"
        autoComplete="off"
        spellCheck={false}
        placeholder={withShortcut("Search", shortcuts.searchHistory)}
        value={query}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          onChange("");
          event.currentTarget.blur();
        }}
      />
    </span>
  );
}

function Header({ actions }: { actions?: ReactNode }) {
  return (
    <header {...stylex.props(styles.header)}>
      <HelpTitle page="meetings" style={styles.headline}>
        Meetings
      </HelpTitle>
      {actions}
    </header>
  );
}

function SettingsButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <Button
            variant="icon"
            aria-label="Meeting settings"
            {...helpAnchor("meetings.settings")}
            onClick={onOpen}
          >
            <SettingsIcon size={16} />
          </Button>
        }
      />
      <Tooltip.Portal>
        <Tooltip.Positioner side="bottom" sideOffset={4} className={tooltipPositionerClass()}>
          <Tooltip.Popup className={tooltipPopupClass()}>Meeting settings</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** The summary model's download, as one line under the header. */
function SummaryModelNotice({ row }: { row: ChecklistRow }) {
  const { status } = row;
  const setupAction = useAction();
  return (
    <>
      <div {...stylex.props(styles.modelNotice)}>
        <SparklesIcon size={16} aria-hidden {...stylex.props(styles.modelIcon)} />
        <p {...stylex.props(styles.modelText)}>{row.subtitle}</p>
        {status.kind !== "needed" && (
          <span
            {...stylex.props(styles.modelStatus, status.kind === "failed" && styles.modelFailed)}
          >
            {status.text}
          </span>
        )}
        {status.kind === "busy" && status.progress !== undefined && (
          <span {...stylex.props(styles.modelProgress)}>
            <ProgressBar label={`${row.title} download`} value={status.progress * 100} />
          </span>
        )}
        {row.actions.map((action) => (
          <Button
            key={action.label}
            variant="secondary"
            aria-label={`${action.label} ${row.title}`}
            onClick={() =>
              void setupAction.run(
                () => runSetupCommand(action.command),
                setupFailure(action.label, row.title),
              )
            }
          >
            {action.label}
          </Button>
        ))}
      </div>
      {setupAction.error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {setupAction.error}
        </p>
      )}
    </>
  );
}

function LiveCard({ meeting, onOpen }: { meeting: LiveMeeting; onOpen: () => void }) {
  const { status } = meeting;
  const action = useAction();
  const run = (command: RecordingCommand) =>
    void action.run(async () => {
      const api = hubApi();
      const send = { pause: api.pauseMeeting, resume: api.resumeMeeting, stop: api.stopMeeting };
      const refusal = commandRefusal(await send[command](meeting.id));
      if (refusal) throw new Error(refusal);
    }, "Could not change the recording. Try again.");
  return (
    <>
      <Card style={styles.live}>
        <span
          aria-hidden="true"
          {...stylex.props(styles.dot, status.kind === "recording" && styles.dotRecording)}
        />
        <div {...stylex.props(styles.liveText)}>
          <button type="button" onClick={onOpen} {...stylex.props(styles.liveTitle)}>
            {titleText(meeting)}
          </button>
          <span {...stylex.props(styles.liveMeta)}>
            {statusView(status).label} · <StatusClock meeting={meeting} />
          </span>
        </div>
        <RecordingControls meeting={meeting} look="page" pending={action.pending} onCommand={run} />
      </Card>
      {action.error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {action.error}
        </p>
      )}
    </>
  );
}

function OverviewPanel({ meeting }: { meeting: Meeting }) {
  const shown = shownSummary(meeting);
  const text = shown && overview(shown.markdown);
  return (
    <aside
      aria-label="Meeting overview"
      {...helpAnchor("meetings.overview")}
      {...stylex.props(styles.aside)}
    >
      <h2 {...stylex.props(styles.asideTitle)}>{titleText(meeting)}</h2>
      <p {...stylex.props(styles.asideWhen)}>{meetingWhen(meeting)}</p>
      <hr {...stylex.props(styles.asideRule)} />
      <h3 {...stylex.props(styles.overviewLabel)}>Overview</h3>
      {text ? (
        <p {...stylex.props(styles.overview)}>
          <Inline text={text} speakers={meeting.speakers} />
        </p>
      ) : (
        <p {...stylex.props(styles.overviewEmpty)}>
          {summaryNotice(meeting)?.text ?? "This summary has no overview."}
        </p>
      )}
    </aside>
  );
}

const SKELETON_DAYS = [0, 1];
const SKELETON_ROWS = [0, 1, 2];

/** The page while the meetings are read: the header over two days of placeholder rows. */
function LoadingPage() {
  return (
    <div aria-busy="true" {...stylex.props(styles.main, styles.mainAlone)}>
      <Header />
      <div {...stylex.props(styles.days)}>
        {SKELETON_DAYS.map((day) => (
          <div key={day} {...stylex.props(styles.day)}>
            <Skeleton width="72px" height="12px" />
            <Card style={styles.clip}>
              {SKELETON_ROWS.map((row) => (
                <div key={row} {...stylex.props(styles.skeletonRow)}>
                  <Skeleton width="40%" height="14px" />
                  <Skeleton width="24%" height="12px" />
                </div>
              ))}
            </Card>
          </div>
        ))}
      </div>
    </div>
  );
}

type PageTab = "notes" | "folders";
const pageTabs = [
  { value: "notes", label: "Past notes" },
  { value: "folders", label: "Folders" },
] as const satisfies readonly { value: PageTab; label: string }[];

type SettingsDialog = { open: boolean; setOpen: (open: boolean) => void };

export function Meetings({
  snapshot,
  settings,
  request = null,
  sidebar,
}: {
  snapshot: Snapshot;
  settings: SettingsDialog;
  request?: OpenMeetingRequest | null;
  sidebar: HTMLElement | null;
}) {
  const meetings = useMeetingsRead();
  const today = useToday();
  if (meetings.kind === "reading") return <LoadingPage />;
  if (meetings.kind === "failed") {
    return (
      <div {...stylex.props(styles.main, styles.mainAlone)}>
        <Header />
        <Card>
          <EmptyState icon={<CircleAlertIcon size={16} />} title="Could not load your meetings.">
            <Button variant="secondary" onClick={meetings.retry}>
              Try again
            </Button>
          </EmptyState>
        </Card>
      </div>
    );
  }
  return (
    <MeetingsPage
      snapshot={snapshot}
      settings={settings}
      sidebar={sidebar}
      state={meetings.value}
      today={today}
      request={request}
    />
  );
}

function MeetingsPage({
  snapshot,
  settings,
  sidebar,
  state,
  today,
  request,
}: {
  snapshot: Snapshot;
  settings: SettingsDialog;
  sidebar: HTMLElement | null;
  state: MeetingsState;
  today: DayKey;
  request: OpenMeetingRequest | null;
}) {
  const { meetings, folders } = state;
  const [openId, setOpenId] = useState<MeetingId | null>(request?.id ?? null);
  const [shownRequest, setShownRequest] = useState(request);
  const [requests, setRequests] = useState(0);
  if (request !== shownRequest) {
    setShownRequest(request);
    setRequests((count) => count + 1);
    if (request) setOpenId(request.id);
  }
  const [tab, setTab] = useState<PageTab>("notes");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<MeetingId | null>(null);
  const [notice, setNotice] = useState("");
  const start = useAction();
  const search = useSearch(query);
  const hits = search === "failed" ? null : search;
  const results = useMemo(() => hits && searchResults(meetings, hits), [meetings, hits]);
  const days = useMemo(
    () => meetingDays(results ? results.map(({ meeting }) => meeting) : meetings, today),
    [meetings, results, today],
  );
  const snippets = useMemo(
    () =>
      results &&
      new Map(results.map(({ meeting, where, snippet }) => [meeting.id, { where, text: snippet }])),
    [results],
  );
  const live = liveMeeting(meetings);
  const keyboard = useKeyboardLayout();
  const { meetingShortcut } = snapshot.settings;
  const setup = meetingsChecklist(snapshot, {
    tried: meetings.length > 0,
    shortcut: meetingShortcut && shortcutLabel(meetingShortcut, keyboard),
  });
  const summaryModel = summaryModelRow(snapshot);
  const opened = meetings.find(({ id }) => id === openId);
  const shown = tab === "notes" ? days.flatMap((day) => day.meetings) : meetings;
  const selected =
    shown.find(({ id }) => id === selectedId) ?? (tab === "notes" ? shown[0] : null) ?? null;
  const asksForSetup = !setup.ready && (sidebar !== null || !opened);
  useEffect(() => {
    if (!asksForSetup) return;
    void hubApi().watchMeetingPermissions(true);
    return () => void hubApi().watchMeetingPermissions(false);
  }, [asksForSetup]);

  const startMeeting = () =>
    void start.run(async () => {
      setNotice("");
      const refusal = commandRefusal(await hubApi().startMeeting());
      if (refusal) setNotice(refusal);
    }, "Could not start the meeting.");

  const setupCard = !setup.ready && <MeetingsSetup rows={setup.rows} consent={CONSENT_REMINDER} />;
  const around = (page: ReactNode) => (
    <>
      {sidebar && setupCard && createPortal(setupCard, sidebar)}
      {page}
      <MeetingsSettingsDialog
        open={settings.open}
        onOpenChange={settings.setOpen}
        settings={state.settings}
        meetings={meetings}
      />
    </>
  );

  if (opened) {
    return around(
      <div {...stylex.props(styles.detail)}>
        <MeetingDetail
          key={`${opened.id}:${requests}`}
          meeting={opened}
          folders={folders}
          notices={snapshot.meetingNotices.filter(({ id }) => id === opened.id)}
          summaryModel={summaryModel}
          onBack={() => setOpenId(null)}
        />
      </div>,
    );
  }

  const startButton = (variant: "primary" | "secondary") => (
    <Button
      variant={variant}
      disabled={start.pending || live !== null}
      onClick={startMeeting}
      {...(variant === "primary" && helpAnchor("meetings.start"))}
    >
      <CircleDotIcon size={16} aria-hidden="true" />
      Start meeting
    </Button>
  );

  const notes =
    meetings.length === 0 ? (
      <Card>
        <EmptyState
          icon={<AudioLinesIcon size={16} />}
          title="No meetings yet"
          description="Start a meeting and Voice writes down what you and the others say, on this Mac. You get a summary when you stop."
        >
          {startButton("secondary")}
        </EmptyState>
      </Card>
    ) : search === "failed" ? (
      <Card>
        <EmptyState icon={<SearchIcon size={16} />} title="Could not search your meetings." />
      </Card>
    ) : results?.length === 0 ? (
      <Card>
        <EmptyState
          icon={<SearchIcon size={16} />}
          title={`No meetings match “${query.trim()}”.`}
        />
      </Card>
    ) : (
      <MeetingList
        days={days}
        folders={folders}
        snippets={snippets}
        selectedId={selected?.id ?? null}
        onSelect={setSelectedId}
        onOpen={setOpenId}
      />
    );

  return around(
    <div {...stylex.props(styles.container)}>
      <div {...stylex.props(styles.layout, !selected && styles.layoutAlone)}>
        <div {...stylex.props(styles.main, !selected && styles.mainAlone)}>
          <Header
            actions={
              <>
                <SettingsButton onOpen={() => settings.setOpen(true)} />
                {startButton("primary")}
              </>
            }
          />
          {summaryModel && <SummaryModelNotice row={summaryModel} />}
          {notice && (
            <p role="status" {...stylex.props(styles.notice)}>
              {notice}
            </p>
          )}
          {start.error && (
            <p role="alert" {...stylex.props(pageStyles.error)}>
              {start.error}
            </p>
          )}
          <MeetingNotices
            notices={snapshot.meetingNotices}
            meetings={meetings}
            onOpen={setOpenId}
            onViewSummary={setOpenId}
          />
          {live && <LiveCard meeting={live} onOpen={() => setOpenId(live.id)} />}
          {!sidebar && setupCard}
          <MeetingTabs
            tabs={pageTabs}
            value={tab}
            onChange={setTab}
            look="page"
            help="meetings.tabs"
            end={
              tab === "notes" && meetings.length > 0 && <Search query={query} onChange={setQuery} />
            }
            style={styles.tabs}
          >
            <Tabs.Panel value="notes" {...stylex.props(styles.panel)}>
              {notes}
            </Tabs.Panel>
            <Tabs.Panel value="folders" {...stylex.props(styles.panel)}>
              <MeetingFolders
                state={state}
                today={today}
                selectedId={selected?.id ?? null}
                onSelect={setSelectedId}
                onOpen={setOpenId}
              />
            </Tabs.Panel>
          </MeetingTabs>
        </div>
        {selected && <OverviewPanel meeting={selected} />}
      </div>
    </div>,
  );
}

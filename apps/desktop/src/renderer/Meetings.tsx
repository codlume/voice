import { Tabs } from "@base-ui/react/tabs";
import * as stylex from "@stylexjs/stylex";
import { AudioLinesIcon, CircleDotIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

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
import { meetingsChecklist, summaryModelRow } from "./checklist.ts";
import { SetupChecklist } from "./Home.tsx";
import { MeetingDetail } from "./MeetingDetail.tsx";
import { MeetingFolders } from "./MeetingFolders.tsx";
import { MeetingList } from "./MeetingList.tsx";
import { MeetingNotices } from "./MeetingNotices.tsx";
import { MeetingTabs, RecordingControls, StatusClock } from "./MeetingParts.tsx";
import { MeetingsSettingsDialog } from "./MeetingsSettingsDialog.tsx";
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
import { pageStyles } from "./pageStyles.ts";
import { shortcutLabel } from "./shortcutCapture.ts";
import { shortcuts, useShortcuts, withShortcut } from "./shortcuts.ts";
import { color, layout, radius, space } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { useKeyboardLayout } from "./useKeyboardLayout.ts";
import { useMeetings } from "./useMeetings.ts";
import { useToday } from "./useToday.ts";
import { hubApi } from "./voice.ts";

const reducedMotion = "@media (prefers-reduced-motion: reduce)";

const styles = stylex.create({
  container: { containerType: "inline-size" },
  layout: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr) 260px", [layout.narrow]: "minmax(0, 1fr)" },
    columnGap: space.xl,
    alignItems: "start",
  },
  layoutAlone: { gridTemplateColumns: "minmax(0, 1fr)" },
  main: { display: "flex", flexDirection: "column", gap: space.lg, minWidth: 0 },
  header: { display: "flex", alignItems: "center", gap: space.sm },
  headline: { flexGrow: 1 },
  notice: { margin: 0, color: color.mutedForeground, fontSize: 12.5 },
  tabs: { display: "flex", flexDirection: "column", gap: space.lg },
  search: { position: "relative", display: "flex", alignItems: "center", marginLeft: "auto" },
  searchIcon: {
    position: "absolute",
    left: 10,
    color: color.mutedForeground,
    pointerEvents: "none",
  },
  searchInput: {
    width: 240,
    height: 30,
    paddingLeft: 30,
    paddingRight: space.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: color.border, ":focus": color.input },
    borderRadius: radius.medium,
    backgroundColor: color.card,
    color: color.foreground,
    font: "inherit",
    fontSize: 13,
  },
  panel: { outline: "none" },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.sm,
    paddingBlock: space.xxl,
    paddingInline: space.lg,
    textAlign: "center",
  },
  emptyIcon: { color: color.mutedForeground },
  emptyTitle: { margin: 0, fontSize: 17, fontWeight: 500 },
  emptyBody: { margin: 0, maxWidth: 400, color: color.mutedForeground },
  emptyAction: { marginTop: space.sm },
  noMatches: { margin: 0, padding: space.lg, color: color.mutedForeground },
  live: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    paddingBlock: space.md,
    paddingInline: space.lg,
  },
  dot: {
    flexShrink: 0,
    width: 10,
    height: 10,
    borderRadius: radius.round,
    backgroundColor: color.mutedForeground,
  },
  dotRecording: {
    backgroundColor: color.error,
    animationName: stylex.keyframes({ "50%": { opacity: 0.35 } }),
    animationDuration: { default: "1.6s", [reducedMotion]: "0s" },
    animationIterationCount: "infinite",
  },
  liveText: { display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0 },
  liveTitle: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: color.foreground,
    font: "inherit",
    fontWeight: 500,
    textAlign: "left",
    cursor: "pointer",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  liveMeta: { color: color.mutedForeground, fontSize: 13, fontVariantNumeric: "tabular-nums" },
  aside: {
    display: { default: "flex", [layout.narrow]: "none" },
    flexDirection: "column",
    gap: space.sm,
    position: "sticky",
    top: 0,
    minHeight: 240,
    paddingLeft: space.xl,
    borderLeftWidth: 1,
    borderLeftStyle: "solid",
    borderLeftColor: color.border,
  },
  asideTitle: {
    margin: 0,
    fontSize: 18,
    fontWeight: 600,
    lineHeight: 1.3,
    overflowWrap: "anywhere",
  },
  asideWhen: { margin: 0, color: color.mutedForeground, fontSize: 13.5 },
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
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: "0.075em",
    textTransform: "uppercase",
  },
  overview: { margin: 0, fontSize: 14.5, lineHeight: 1.65 },
  overviewEmpty: { margin: 0, color: color.mutedForeground },
});

const SEARCH_DELAY_MS = 150;

/** Main's hits for `query`, asked once typing pauses. The last answer stays up while the next one loads. */
function useSearch(query: string): readonly MeetingSearchHit[] | null {
  const trimmed = query.trim();
  const [hits, setHits] = useState<readonly MeetingSearchHit[] | null>(null);
  useEffect(() => {
    if (trimmed === "") return;
    let current = true;
    const timer = setTimeout(() => {
      void hubApi()
        .searchMeetings(trimmed)
        .then((next) => {
          if (current) setHits(next);
        });
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [trimmed]);
  return trimmed === "" ? null : hits;
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
    <div {...stylex.props(styles.search)}>
      <SearchIcon size={14} aria-hidden="true" {...stylex.props(styles.searchIcon)} />
      <input
        ref={input}
        type="search"
        aria-label="Search meetings"
        autoComplete="off"
        spellCheck={false}
        placeholder={withShortcut("Search meetings", shortcuts.searchHistory)}
        value={query}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          onChange("");
          event.currentTarget.blur();
        }}
        {...stylex.props(styles.searchInput)}
      />
    </div>
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
    }, "Could not change the recording.");
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
    <aside aria-label="Meeting overview" {...stylex.props(styles.aside)}>
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
}: {
  snapshot: Snapshot;
  settings: SettingsDialog;
  /** A meeting main asked to show on its summary. */
  request?: OpenMeetingRequest | null;
}) {
  const state = useMeetings();
  const today = useToday();
  return state ? (
    <MeetingsPage
      snapshot={snapshot}
      settings={settings}
      state={state}
      today={today}
      request={request}
    />
  ) : null;
}

function MeetingsPage({
  snapshot,
  settings,
  state,
  today,
  request,
}: {
  snapshot: Snapshot;
  settings: SettingsDialog;
  state: MeetingsState;
  today: DayKey;
  request: OpenMeetingRequest | null;
}) {
  const { meetings, folders } = state;
  const [openId, setOpenId] = useState<MeetingId | null>(request?.id ?? null);
  // Each request opens its meeting afresh, so the page lands on the Summary tab it asks for.
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
  const hits = useSearch(query);
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
  // The panel describes a meeting the list shows: a search result, or any meeting in a folder.
  const shown = tab === "notes" ? days.flatMap((day) => day.meetings) : meetings;
  const selected =
    shown.find(({ id }) => id === selectedId) ?? (tab === "notes" ? shown[0] : null) ?? null;
  // Main checks System Audio Recording again only while Set up Meetings asks for it.
  const asksForSetup = !setup.ready && !opened;
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

  if (opened) {
    return (
      <MeetingDetail
        key={`${opened.id}:${requests}`}
        meeting={opened}
        folders={folders}
        notices={snapshot.meetingNotices.filter(({ id }) => id === opened.id)}
        summaryModel={summaryModel}
        onBack={() => setOpenId(null)}
      />
    );
  }

  const startButton = (variant: "primary" | "secondary") => (
    <Button variant={variant} disabled={start.pending || live !== null} onClick={startMeeting}>
      <CircleDotIcon size={15} aria-hidden="true" />
      Start meeting
    </Button>
  );

  const notes =
    meetings.length === 0 ? (
      <Card>
        <div {...stylex.props(styles.empty)}>
          <AudioLinesIcon size={28} aria-hidden="true" {...stylex.props(styles.emptyIcon)} />
          <p {...stylex.props(styles.emptyTitle)}>No meetings yet</p>
          <p {...stylex.props(styles.emptyBody)}>
            Start a meeting and Voice writes down what you and the others say, on this Mac. You get
            a summary when you stop.
          </p>
          <div {...stylex.props(styles.emptyAction)}>{startButton("secondary")}</div>
        </div>
      </Card>
    ) : results && results.length === 0 ? (
      <Card>
        <p {...stylex.props(styles.noMatches)}>No meetings match “{query.trim()}”.</p>
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

  return (
    <div {...stylex.props(styles.container)}>
      <div {...stylex.props(styles.layout, !selected && styles.layoutAlone)}>
        <div {...stylex.props(styles.main)}>
          <div {...stylex.props(styles.header)}>
            <h1 {...stylex.props(pageStyles.headline, styles.headline)}>Meetings</h1>
            <Button
              variant="icon"
              aria-label="Meeting settings"
              title="Meeting settings"
              onClick={() => settings.setOpen(true)}
            >
              <SettingsIcon size={17} />
            </Button>
            {startButton("primary")}
          </div>
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
          {!setup.ready && (
            <SetupChecklist
              title="Set up Meetings"
              rows={setup.rows}
              after={<p {...stylex.props(styles.notice)}>{CONSENT_REMINDER}</p>}
            />
          )}
          {summaryModel && (
            <SetupChecklist title="Summaries" rows={[summaryModel]} counted={false} />
          )}
          <MeetingTabs
            tabs={pageTabs}
            value={tab}
            onChange={setTab}
            look="page"
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
      <MeetingsSettingsDialog
        open={settings.open}
        onOpenChange={settings.setOpen}
        settings={state.settings}
        meetings={meetings}
      />
    </div>
  );
}

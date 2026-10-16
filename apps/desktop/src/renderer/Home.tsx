import { Progress } from "@base-ui/react/progress";
import * as stylex from "@stylexjs/stylex";
import { CheckIcon } from "lucide-react";
import { useId, useMemo } from "react";

import type { Settings, Snapshot } from "../shared/api.ts";
import type { HistoryState } from "../shared/history.ts";
import type { DayKey } from "../shared/insights.ts";
import { a11y } from "./a11y.ts";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { checklist, type ChecklistRow, type SetupCommand } from "./checklist.ts";
import { History } from "./History.tsx";
import { dictatesWithFn, hotkeyKeycap, hotkeyLabel } from "./hotkeys.ts";
import { insightsView } from "./insightsView.ts";
import { Keycap } from "./Keycap.tsx";
import { pageStyles } from "./pageStyles.ts";
import { GlobeHint } from "./Settings.tsx";
import { Switch } from "./Switch.tsx";
import { color, font, motion, radius, space } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { useInsights } from "./useInsights.ts";
import { useToday } from "./useToday.ts";
import { hubApi } from "./voice.ts";

const narrow = "@container (max-width: 720px)";

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.xl, containerType: "inline-size" },
  columns: {
    display: "flex",
    flexDirection: { default: "row", [narrow]: "column" },
    alignItems: { default: "flex-start", [narrow]: "stretch" },
    gap: space.lg,
  },
  main: {
    display: "flex",
    flexDirection: "column",
    gap: space.xl,
    flexGrow: 1,
    minWidth: 0,
  },
  aside: {
    position: { default: "sticky", [narrow]: "static" },
    top: 0,
    flexShrink: 0,
    width: { default: 250, [narrow]: "auto" },
    order: { default: 0, [narrow]: -1 },
  },
  lede: {
    margin: 0,
    marginTop: space.sm,
    color: color.mutedForeground,
    fontSize: 15,
    lineHeight: 1.6,
  },
  section: { display: "flex", flexDirection: "column", gap: space.sm },
  sectionHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between" },
  label: { margin: 0, fontSize: 13, fontWeight: 600 },
  note: { margin: 0, color: color.mutedForeground, fontSize: 12.5 },
  list: { margin: 0, padding: 0, listStyle: "none" },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    paddingBlock: 14,
    paddingInline: space.lg,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  rowText: { flexGrow: 1, minWidth: 0 },
  rowTitle: { display: "block", margin: 0, fontWeight: 500 },
  rowSubtitle: { margin: 0, color: color.mutedForeground, fontSize: 12.5 },
  status: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 6,
    flexShrink: 0,
    maxWidth: 220,
    color: color.mutedForeground,
    fontSize: 12.5,
    textAlign: "right",
  },
  statusReady: { color: color.successForeground },
  statusFailed: { color: color.errorForeground },
  track: {
    width: 120,
    height: 4,
    overflow: "hidden",
    borderRadius: radius.round,
    backgroundColor: color.accent,
  },
  fill: {
    height: "100%",
    backgroundColor: color.primary,
    transitionProperty: "width",
    transitionDuration: `calc(300ms * ${motion["--motion-scale"]})`,
  },
  mark: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 20,
    height: 20,
    borderWidth: 1.5,
    borderStyle: "solid",
    borderColor: color.input,
    borderRadius: radius.round,
  },
  markReady: {
    borderColor: color.success,
    backgroundColor: color.success,
    color: color.primaryForeground,
  },
  markFailed: { borderColor: color.error },
  markBusy: { borderStyle: "dashed", borderColor: color.foreground },
  markEmpty: { borderColor: "transparent" },
  tryIt: { display: "flex", flexDirection: "column", gap: space.sm, padding: space.lg },
  textarea: {
    width: "100%",
    minHeight: 96,
    padding: space.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: color.border, ":focus": color.input },
    borderRadius: radius.medium,
    backgroundColor: color.background,
    color: color.foreground,
    font: "inherit",
    fontSize: 15,
    lineHeight: 1.5,
    resize: "vertical",
    outline: "none",
  },
  stats: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    padding: 0,
    borderWidth: 0,
    borderRadius: "inherit",
    backgroundColor: { default: "transparent", ":hover": color.accent },
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
  },
  statList: {
    display: "flex",
    flexDirection: { default: "column", [narrow]: "row" },
    flexWrap: "wrap",
    gap: { default: space.md, [narrow]: space.xl },
    padding: space.lg,
  },
  stat: { display: "flex", alignItems: "baseline", gap: space.sm },
  statValue: {
    fontFamily: font.serif,
    fontSize: 28,
    fontWeight: 400,
    lineHeight: 1.1,
    letterSpacing: "-0.02em",
    fontVariantNumeric: "tabular-nums",
  },
  statLabel: { color: color.mutedForeground, fontSize: 14 },
  statFoot: {
    paddingBlock: space.md,
    paddingInline: space.lg,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: color.border,
    color: color.mutedForeground,
    fontSize: 12.5,
  },
});

function greeting(hour: number): string {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function run(command: SetupCommand): Promise<void> {
  switch (command.type) {
    case "installModel":
      return hubApi().installModel(command.id);
    case "uninstallModel":
      return hubApi().uninstallModel(command.id);
    case "requestPermission":
      return hubApi().requestPermission(command.kind);
  }
}

function SetupRow({ row }: { row: ChecklistRow }) {
  const { status, actions } = row;
  return (
    <li {...stylex.props(styles.row)}>
      <span
        {...stylex.props(
          styles.mark,
          status.kind === "ready" && styles.markReady,
          status.kind === "failed" && styles.markFailed,
          status.kind === "busy" && styles.markBusy,
        )}
      >
        {status.kind === "ready" && <CheckIcon size={12} strokeWidth={3} />}
      </span>
      <div {...stylex.props(styles.rowText)}>
        <p {...stylex.props(styles.rowTitle)}>{row.title}</p>
        <p {...stylex.props(styles.rowSubtitle)}>{row.subtitle}</p>
      </div>
      <div
        {...stylex.props(
          styles.status,
          status.kind === "ready" && styles.statusReady,
          status.kind === "failed" && styles.statusFailed,
        )}
      >
        <span>{status.text}</span>
        {status.kind === "busy" && status.progress !== undefined && (
          <Progress.Root aria-label={`${row.title} download`} value={status.progress * 100}>
            <Progress.Track {...stylex.props(styles.track)}>
              <Progress.Indicator {...stylex.props(styles.fill)} />
            </Progress.Track>
          </Progress.Root>
        )}
      </div>
      {actions.map((action) => (
        <Button
          key={action.label}
          aria-label={`${action.label} ${row.title}`}
          onClick={() => void run(action.command)}
        >
          {action.label}
        </Button>
      ))}
    </li>
  );
}

function CrashReportsRow({ on }: { on: boolean }) {
  const id = useId();
  const diagnosticsAction = useAction();
  return (
    <div {...stylex.props(styles.row)}>
      <span {...stylex.props(styles.mark, styles.markEmpty)} />
      <div {...stylex.props(styles.rowText)}>
        <label htmlFor={id} {...stylex.props(styles.rowTitle)}>
          Crash reports
        </label>
        <p {...stylex.props(styles.rowSubtitle)}>
          Crashes, timings, and app events. Never your words or audio.
        </p>
        {diagnosticsAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {diagnosticsAction.error}
          </p>
        )}
      </div>
      <Switch
        id={id}
        checked={on}
        onChange={(checked) =>
          void diagnosticsAction.run(
            () => hubApi().updateSettings({ diagnostics: checked ? "on" : "off" }),
            "Could not save settings.",
          )
        }
      />
    </div>
  );
}

function Setup({ snapshot, rows }: { snapshot: Snapshot; rows: readonly ChecklistRow[] }) {
  const done = rows.filter((row) => row.status.kind === "ready").length;
  return (
    <section aria-labelledby="setup" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHead)}>
        <h2 id="setup" {...stylex.props(styles.label)}>
          Set up Voice
        </h2>
        <p {...stylex.props(styles.note)}>
          {done} of {rows.length} done
        </p>
      </div>
      <Card>
        <ul {...stylex.props(styles.list)}>
          {rows.map((row) => (
            <SetupRow key={row.id} row={row} />
          ))}
        </ul>
        <CrashReportsRow on={snapshot.settings.diagnostics === "on"} />
      </Card>
      {dictatesWithFn(snapshot.settings) && <GlobeHint />}
    </section>
  );
}

function TryIt({ settings }: { settings: Settings }) {
  const id = useId();
  return (
    <Card style={styles.tryIt}>
      <label htmlFor={id} {...stylex.props(styles.label)}>
        Try it
      </label>
      <textarea
        id={id}
        placeholder={`Click here, hold ${hotkeyLabel(settings.hotkey)}, and say something.`}
        {...stylex.props(styles.textarea)}
      />
      {dictatesWithFn(settings) && <GlobeHint />}
    </Card>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <span {...stylex.props(styles.stat)}>
      <span {...stylex.props(styles.statValue)}>{value}</span>
      <span {...stylex.props(styles.statLabel)}>{label}</span>
    </span>
  );
}

function Stats({ today, onOpenInsights }: { today: DayKey; onOpenInsights: () => void }) {
  const insights = useInsights();
  const view = useMemo(() => insights && insightsView(insights, today, 1), [insights, today]);
  return (
    <Card>
      <button type="button" onClick={onOpenInsights} {...stylex.props(styles.stats)}>
        <span {...stylex.props(a11y.visuallyHidden)}>Open Insights.</span>
        <span {...stylex.props(styles.statList)}>
          <Stat value={view ? view.totalWords.toLocaleString() : "–"} label="words" />
          <Stat value={view?.pace ? String(view.pace.wpm) : "–"} label="WPM" />
          <Stat value={view ? String(view.streak.current) : "–"} label="day streak" />
        </span>
        {view?.pace?.fasterThanTyping && (
          <span {...stylex.props(styles.statFoot)}>
            {view.pace.fasterThanTyping.toFixed(1)}× faster than typing
          </span>
        )}
      </button>
    </Card>
  );
}

export function Home({
  snapshot,
  history,
  onOpenInsights,
}: {
  snapshot: Snapshot;
  history: HistoryState;
  onOpenInsights: () => void;
}) {
  const { ready, rows } = checklist(snapshot);
  const today = useToday();
  return (
    <div {...stylex.props(styles.page)}>
      <header>
        <h1 {...stylex.props(pageStyles.headline)}>{greeting(new Date().getHours())}</h1>
        <p {...stylex.props(styles.lede)}>
          Hold <Keycap>{hotkeyKeycap(snapshot.settings.hotkey)}</Keycap>, speak, and let go
          {snapshot.settings.toggleHotkey && (
            <>
              , or tap <Keycap>{hotkeyKeycap(snapshot.settings.toggleHotkey)}</Keycap> to start and
              again to stop
            </>
          )}
          . Voice types it wherever your cursor is.
        </p>
      </header>
      <div {...stylex.props(styles.columns)}>
        <div {...stylex.props(styles.main)}>
          {ready ? (
            <TryIt settings={snapshot.settings} />
          ) : (
            <Setup snapshot={snapshot} rows={rows} />
          )}
          <History history={history} today={today} />
        </div>
        <aside aria-label="Your stats" {...stylex.props(styles.aside)}>
          <Stats today={today} onOpenInsights={onOpenInsights} />
        </aside>
      </div>
    </div>
  );
}

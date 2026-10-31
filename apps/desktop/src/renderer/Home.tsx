import { Progress } from "@base-ui/react/progress";
import * as stylex from "@stylexjs/stylex";
import { CheckIcon } from "lucide-react";
import { useId, type ReactNode } from "react";

import type { Settings, Snapshot } from "../shared/api.ts";
import type { HistoryState } from "../shared/history.ts";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { checklist, settled, type ChecklistRow, type SetupCommand } from "./checklist.ts";
import { History } from "./History.tsx";
import { YourStats } from "./HomeStats.tsx";
import { dictatesWithFn, hotkeyKeycap, hotkeyLabel } from "./hotkeys.ts";
import { Keycap } from "./Keycap.tsx";
import { pageStyles } from "./pageStyles.ts";
import { GlobeHint } from "./Settings.tsx";
import { Switch } from "./Switch.tsx";
import { color, layout, radius, space } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { useToday } from "./useToday.ts";
import { hubApi } from "./voice.ts";

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.xl, containerType: "inline-size" },
  columns: {
    display: "flex",
    flexDirection: { default: "row", [layout.narrow]: "column" },
    alignItems: { default: "flex-start", [layout.narrow]: "stretch" },
    gap: space.lg,
  },
  main: {
    display: "flex",
    flexDirection: "column",
    gap: space.xl,
    flexGrow: 1,
    minWidth: 0,
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
    transitionDuration: "300ms",
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
    case "downloadSpeakerModel":
      return hubApi().downloadSpeakerModel();
  }
}

export function SetupRow({ row }: { row: ChecklistRow }) {
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

export function SetupChecklist({
  title,
  rows,
  children,
  after,
  counted = true,
}: {
  title: string;
  rows: readonly ChecklistRow[];
  counted?: boolean;
  /** More rows inside the card, below the list. */
  children?: ReactNode;
  after?: ReactNode;
}) {
  const id = useId();
  const done = rows.filter(settled).length;
  return (
    <section aria-labelledby={id} {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHead)}>
        <h2 id={id} {...stylex.props(styles.label)}>
          {title}
        </h2>
        {counted && (
          <p {...stylex.props(styles.note)}>
            {done} of {rows.length} done
          </p>
        )}
      </div>
      <Card>
        <ul {...stylex.props(styles.list)}>
          {rows.map((row) => (
            <SetupRow key={row.id} row={row} />
          ))}
        </ul>
        {children}
      </Card>
      {after}
    </section>
  );
}

function Setup({ snapshot, rows }: { snapshot: Snapshot; rows: readonly ChecklistRow[] }) {
  return (
    <SetupChecklist
      title="Set up Voice"
      rows={rows}
      after={dictatesWithFn(snapshot.settings) && <GlobeHint />}
    >
      <CrashReportsRow on={snapshot.settings.diagnostics === "on"} />
    </SetupChecklist>
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
        <YourStats
          today={today}
          assignments={snapshot.settings.cleanup.assignments}
          onOpenInsights={onOpenInsights}
        />
      </div>
    </div>
  );
}

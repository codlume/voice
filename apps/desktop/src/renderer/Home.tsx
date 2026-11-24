import * as stylex from "@stylexjs/stylex";
import { useId } from "react";

import type { Settings, Snapshot } from "../shared/api.ts";
import type { HistoryState } from "../shared/history.ts";
import { Card } from "./Card.tsx";
import { checklist, type ChecklistRow } from "./checklist.ts";
import { History } from "./History.tsx";
import { YourStats } from "./HomeStats.tsx";
import { dictatesWithFn, hotkeyKeycap, hotkeyLabel } from "./hotkeys.ts";
import { Keycap } from "./Keycap.tsx";
import { pageStyles } from "./pageStyles.ts";
import { GlobeHint } from "./settingsParts.tsx";
import { CrashReportsRow, SetupChecklist } from "./SetupChecklist.tsx";
import { color, layout, radius, space } from "./tokens.stylex.ts";
import { useClock, useToday } from "./useToday.ts";

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
  label: { margin: 0, fontSize: 13, fontWeight: 600 },
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
  },
});

function greetingAt(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
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
  const greeting = useClock(greetingAt);
  return (
    <div {...stylex.props(styles.page)}>
      <header>
        <h1 {...stylex.props(pageStyles.headline)}>{greeting}</h1>
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

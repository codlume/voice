import * as stylex from "@stylexjs/stylex";
import { MicIcon } from "lucide-react";
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
import { surfaces } from "./surfaces.ts";
import { color, font, layout, leading, space, text } from "./tokens.stylex.ts";
import { useClock, useToday } from "./useToday.ts";

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.xl, containerType: "inline-size" },
  header: { display: "flex", flexDirection: "column", gap: space.md },
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
    color: color.mutedForeground,
    fontSize: text.sm,
    lineHeight: leading.sm,
  },
  label: { margin: 0, fontSize: text.sm, fontWeight: 500, lineHeight: leading.sm },
  tryIt: { display: "flex", flexDirection: "column", gap: space.sm, padding: space.base },
  textarea: {
    width: "100%",
    minHeight: 96,
    paddingBlock: space.sm,
    paddingInline: 11,
    fontFamily: font.sans,
    fontSize: text.sm,
    lineHeight: leading.sm,
    resize: "vertical",
    "::placeholder": { color: color.mutedForeground },
  },
  line: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.sm,
    paddingBlock: 5,
    paddingInline: 11,
    cursor: "text",
  },
  lineIcon: { flexShrink: 0, marginTop: 2, color: color.mutedForeground },
  lineField: {
    flexGrow: 1,
    minWidth: 0,
    maxHeight: 120,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: color.foreground,
    fontFamily: font.sans,
    fontSize: text.sm,
    lineHeight: leading.sm,
    outline: "none",
    resize: "none",
    fieldSizing: "content",
    "::placeholder": { color: color.mutedForeground },
  },
  lineHint: {
    display: "flex",
    alignItems: "center",
    gap: space.xxs,
    flexShrink: 0,
    color: color.mutedForeground,
    fontSize: text.xs,
    lineHeight: leading.sm,
    whiteSpace: "nowrap",
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

function Lede({ settings }: { settings: Settings }) {
  return (
    <p {...stylex.props(styles.lede)}>
      Hold <Keycap>{hotkeyKeycap(settings.hotkey)}</Keycap>, speak, and let go
      {settings.toggleHotkey && (
        <>
          , or tap <Keycap>{hotkeyKeycap(settings.toggleHotkey)}</Keycap> to start and again to stop
        </>
      )}
      . Voice types it wherever your cursor is.
    </p>
  );
}

/** The first-run practice box: a labelled field with room for a few sentences. */
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
        {...stylex.props(surfaces.control, surfaces.field, styles.textarea)}
      />
      {dictatesWithFn(settings) && <GlobeHint />}
    </Card>
  );
}

/** Once history has entries, the practice box is one line that grows with what lands in it. */
function TryItLine({ settings }: { settings: Settings }) {
  return (
    <label {...stylex.props(surfaces.control, surfaces.field, styles.line)}>
      <MicIcon size={16} aria-hidden {...stylex.props(styles.lineIcon)} />
      <textarea
        aria-label="Try it"
        rows={1}
        placeholder="Click here to try it"
        {...stylex.props(styles.lineField)}
      />
      <span aria-hidden {...stylex.props(styles.lineHint)}>
        Hold <Keycap>{hotkeyKeycap(settings.hotkey)}</Keycap> and speak
      </span>
    </label>
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
  const returning = ready && history.entries.length > 0;
  return (
    <div {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.header)}>
        <h1 {...stylex.props(pageStyles.headline)}>{greeting}</h1>
        {returning ? (
          <TryItLine settings={snapshot.settings} />
        ) : (
          <Lede settings={snapshot.settings} />
        )}
      </header>
      <div {...stylex.props(styles.columns)}>
        <div {...stylex.props(styles.main)}>
          {!ready && <Setup snapshot={snapshot} rows={rows} />}
          {ready && !returning && <TryIt settings={snapshot.settings} />}
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

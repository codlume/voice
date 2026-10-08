import { Progress } from "@base-ui/react/progress";
import { Toggle } from "@base-ui/react/toggle";
import * as stylex from "@stylexjs/stylex";
import { CheckIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import type { Hotkey, Snapshot } from "../shared/api.ts";
import { Button } from "./Button.tsx";
import { checklist, hotkeyLabels, type ChecklistRow, type SetupCommand } from "./checklist.ts";
import { GlobeHint } from "./Settings.tsx";
import { Switch } from "./Switch.tsx";
import { color, font, radius, space } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.xl },
  headline: {
    margin: 0,
    fontFamily: font.serif,
    fontSize: 36,
    fontWeight: 400,
    lineHeight: 1.15,
    letterSpacing: "-0.01em",
  },
  lede: { margin: 0, marginTop: space.sm, color: color.mutedForeground, fontSize: 15 },
  section: { display: "flex", flexDirection: "column", gap: space.sm },
  sectionHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between" },
  label: { margin: 0, fontSize: 13, fontWeight: 600 },
  aside: { margin: 0, color: color.mutedForeground, fontSize: 12.5 },
  card: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.large,
    backgroundColor: color.card,
  },
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
  error: { margin: 0, color: color.errorForeground, fontSize: 12.5 },
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
  markReady: { borderColor: color.success, backgroundColor: color.success },
  markFailed: { borderColor: color.error },
  markBusy: { borderStyle: "dashed", borderColor: color.foreground },
  markEmpty: { borderColor: "transparent" },
  ready: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    paddingBlock: 14,
    paddingInline: space.lg,
    fontSize: 15,
  },
  textarea: {
    width: "100%",
    minHeight: 112,
    padding: space.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: color.border, ":focus": color.input },
    borderRadius: radius.large,
    backgroundColor: color.card,
    color: color.foreground,
    font: "inherit",
    fontSize: 15,
    lineHeight: 1.5,
    resize: "vertical",
    outline: "none",
  },
  transcript: {
    margin: 0,
    padding: space.lg,
    fontSize: 15,
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  transcriptRaw: { color: color.mutedForeground },
  empty: { margin: 0, padding: space.lg, color: color.mutedForeground },
  cardFoot: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    paddingBlock: space.md,
    paddingInline: space.lg,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  spacer: { flexGrow: 1 },
  toggle: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: { default: color.mutedForeground, ":hover": color.foreground },
    font: "inherit",
    fontSize: 12.5,
    cursor: "pointer",
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
      return window.voice.installModel(command.id);
    case "requestPermission":
      return window.voice.requestPermission(command.kind);
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
        {status.kind === "ready" && <CheckIcon size={12} strokeWidth={3} color="white" />}
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
          <p role="alert" {...stylex.props(styles.error)}>
            {diagnosticsAction.error}
          </p>
        )}
      </div>
      <Switch
        id={id}
        checked={on}
        onChange={(checked) =>
          void diagnosticsAction.run(
            () => window.voice.updateSettings({ diagnostics: checked ? "on" : "off" }),
            "Could not save settings.",
          )
        }
      />
    </div>
  );
}

function Setup({ snapshot }: { snapshot: Snapshot }) {
  const { ready, rows } = checklist(snapshot);
  if (ready) {
    return (
      <div {...stylex.props(styles.card, styles.ready)}>
        <span {...stylex.props(styles.mark, styles.markReady)}>
          <CheckIcon size={12} strokeWidth={3} color="white" />
        </span>
        Ready. Hold {hotkeyLabels[snapshot.settings.hotkey]} and speak.
      </div>
    );
  }
  const done = rows.filter((row) => row.status.kind === "ready").length;
  return (
    <section aria-labelledby="setup" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHead)}>
        <h2 id="setup" {...stylex.props(styles.label)}>
          Set up Voice
        </h2>
        <p {...stylex.props(styles.aside)}>
          {done} of {rows.length} done
        </p>
      </div>
      <div {...stylex.props(styles.card)}>
        <ul {...stylex.props(styles.list)}>
          {rows.map((row) => (
            <SetupRow key={row.id} row={row} />
          ))}
        </ul>
        <CrashReportsRow on={snapshot.settings.diagnostics === "on"} />
      </div>
    </section>
  );
}

function TryIt({ hotkey }: { hotkey: Hotkey }) {
  const id = useId();
  return (
    <section {...stylex.props(styles.section)}>
      <label htmlFor={id} {...stylex.props(styles.label)}>
        Try it
      </label>
      <textarea
        id={id}
        placeholder={`Click here, hold ${hotkeyLabels[hotkey]}, and say something.`}
        {...stylex.props(styles.textarea)}
      />
      {hotkey === "fn" && <GlobeHint />}
    </section>
  );
}

function LastDictation({ last }: { last: Snapshot["last"] }) {
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState<"text" | "raw" | null>(null);
  const copyAction = useAction();

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = (which: "text" | "raw") =>
    void copyAction.run(async () => {
      await window.voice.copyLast(which);
      setCopied(which);
    }, "Could not copy the transcript.");
  const hasRaw = last !== null && last.raw !== last.text;

  return (
    <section aria-labelledby="last" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHead)}>
        <h2 id="last" {...stylex.props(styles.label)}>
          Last dictation
        </h2>
        <p {...stylex.props(styles.aside)}>Kept in memory only</p>
      </div>
      <div {...stylex.props(styles.card)}>
        {last === null ? (
          <p {...stylex.props(styles.empty)}>
            Your last dictation shows up here, so you can copy it if it didn't land.
          </p>
        ) : (
          <>
            <p {...stylex.props(styles.transcript, showRaw && hasRaw && styles.transcriptRaw)}>
              {showRaw && hasRaw ? last.raw : last.text}
            </p>
            <div {...stylex.props(styles.cardFoot)}>
              <Button variant="secondary" onClick={() => copy("text")}>
                {copied === "text" ? "Copied" : "Copy"}
              </Button>
              {hasRaw && (
                <Button variant="secondary" onClick={() => copy("raw")}>
                  {copied === "raw" ? "Copied" : "Copy raw"}
                </Button>
              )}
              <span {...stylex.props(styles.spacer)} />
              {hasRaw && (
                <Toggle
                  pressed={showRaw}
                  onPressedChange={setShowRaw}
                  {...stylex.props(styles.toggle)}
                >
                  Show raw transcript
                </Toggle>
              )}
            </div>
          </>
        )}
      </div>
      {copyAction.error && (
        <p role="alert" {...stylex.props(styles.error)}>
          {copyAction.error}
        </p>
      )}
    </section>
  );
}

export function Home({ snapshot }: { snapshot: Snapshot }) {
  const hotkey = hotkeyLabels[snapshot.settings.hotkey];
  return (
    <div {...stylex.props(styles.page)}>
      <header>
        <h1 {...stylex.props(styles.headline)}>{greeting(new Date().getHours())}</h1>
        <p {...stylex.props(styles.lede)}>
          Hold {hotkey}, speak, and let go. Voice types it wherever your cursor is.
        </p>
      </header>
      <Setup snapshot={snapshot} />
      <TryIt hotkey={snapshot.settings.hotkey} />
      <LastDictation last={snapshot.last} />
    </div>
  );
}

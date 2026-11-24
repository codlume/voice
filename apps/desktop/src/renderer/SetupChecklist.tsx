import { Progress } from "@base-ui/react/progress";
import * as stylex from "@stylexjs/stylex";
import { CheckIcon } from "lucide-react";
import { useId, type ReactNode } from "react";

import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { settled, type ChecklistRow, type SetupCommand } from "./checklist.ts";
import { pageStyles } from "./pageStyles.ts";
import { Switch } from "./Switch.tsx";
import { color, radius, space } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";

const reducedMotion = "@media (prefers-reduced-motion: reduce)";

const styles = stylex.create({
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
    transitionDuration: { default: "300ms", [reducedMotion]: "0s" },
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
});

export function runSetupCommand(command: SetupCommand): Promise<void> {
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

export const setupFailure = (label: string, title: string) =>
  `Could not ${label.toLowerCase()} ${title}.`;

function SetupRow({ row }: { row: ChecklistRow }) {
  const { status, actions } = row;
  const setupAction = useAction();
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
        {setupAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {setupAction.error}
          </p>
        )}
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
    </li>
  );
}

export function CrashReportsRow({ on }: { on: boolean }) {
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

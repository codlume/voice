import * as stylex from "@stylexjs/stylex";
import {
  ActivityIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  CircleMinusIcon,
  type LucideIcon,
} from "lucide-react";
import { useId, type ReactNode } from "react";

import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { settled, type ChecklistRow, type SetupCommand } from "./checklist.ts";
import { pageStyles } from "./pageStyles.ts";
import { ProgressBar } from "./Skeleton.tsx";
import { Switch } from "./Switch.tsx";
import { color, leading, space, text } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";

const styles = stylex.create({
  section: { display: "flex", flexDirection: "column", gap: space.md },
  sectionHead: { display: "flex", alignItems: "center", gap: space.md, minHeight: 32 },
  label: { flexGrow: 1, margin: 0, fontSize: text.sm, fontWeight: 600, lineHeight: leading.sm },
  progress: { display: "flex", alignItems: "center", gap: space.sm, flexShrink: 0 },
  progressBar: { width: 96 },
  note: {
    margin: 0,
    color: color.mutedForeground,
    fontSize: text.xs,
    lineHeight: leading.xs,
    fontVariantNumeric: "tabular-nums",
  },
  list: { margin: 0, padding: 0, listStyle: "none" },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    minHeight: 56,
    paddingBlock: space.md,
    paddingInline: space.base,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  icon: { flexShrink: 0, color: color.mutedForeground },
  iconReady: { color: color.successForeground },
  iconFailed: { color: color.errorForeground },
  rowText: { display: "flex", flexDirection: "column", gap: 2, flexGrow: 1, minWidth: 0 },
  rowTitle: {
    display: "block",
    margin: 0,
    fontSize: text.sm,
    fontWeight: 500,
    lineHeight: leading.sm,
  },
  rowSubtitle: {
    margin: 0,
    color: color.mutedForeground,
    fontSize: text.xs,
    lineHeight: leading.xs,
  },
  status: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: space.xs,
    flexShrink: 0,
    maxWidth: 220,
    color: color.mutedForeground,
    fontSize: text.xs,
    lineHeight: leading.xs,
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
  },
  statusReady: { color: color.successForeground },
  statusFailed: { color: color.errorForeground },
  download: { width: 120 },
});

const statusIcons: Record<ChecklistRow["status"]["kind"], LucideIcon> = {
  ready: CircleCheckIcon,
  needed: CircleIcon,
  busy: CircleDashedIcon,
  failed: CircleAlertIcon,
  unavailable: CircleMinusIcon,
};

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
  const StatusIcon = statusIcons[status.kind];
  return (
    <li {...stylex.props(styles.row)}>
      <StatusIcon
        size={16}
        aria-hidden
        {...stylex.props(
          styles.icon,
          status.kind === "ready" && styles.iconReady,
          status.kind === "failed" && styles.iconFailed,
        )}
      />
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
          <span {...stylex.props(styles.download)}>
            <ProgressBar label={`${row.title} download`} value={status.progress * 100} />
          </span>
        )}
      </div>
      {actions.map((action) => (
        <Button
          key={action.label}
          variant={action.label === "Cancel" ? "secondary" : "primary"}
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
      <ActivityIcon size={16} aria-hidden {...stylex.props(styles.icon)} />
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
          <div {...stylex.props(styles.progress)}>
            <p {...stylex.props(styles.note)}>
              {done} of {rows.length} done
            </p>
            <div {...stylex.props(styles.progressBar)}>
              <ProgressBar label={`${title} progress`} value={(done / rows.length) * 100} />
            </div>
          </div>
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

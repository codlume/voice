import * as stylex from "@stylexjs/stylex";
import { CheckIcon } from "lucide-react";
import { useId } from "react";

import { settled, type ChecklistRow } from "./checklist.ts";
import { runSetupCommand, setupFailure } from "./SetupChecklist.tsx";
import { pageStyles } from "./pageStyles.ts";
import { ProgressBar } from "./Skeleton.tsx";
import { color, elevation, font, leading, radius, space, text } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";

const styles = stylex.create({
  card: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    padding: space.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.large,
    backgroundColor: color.card,
    boxShadow: elevation.xs,
    whiteSpace: "normal",
    cursor: "default",
  },
  title: { margin: 0, fontSize: text.sm, fontWeight: 600, lineHeight: leading.sm },
  list: { display: "flex", flexDirection: "column", gap: space.sm, margin: 0, padding: 0 },
  row: { display: "flex", alignItems: "flex-start", gap: space.sm, listStyle: "none" },
  mark: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 16,
    height: 16,
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
  text: { display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0 },
  label: { margin: 0, fontSize: text.xs, lineHeight: leading.xs },
  labelDone: { color: color.mutedForeground },
  hint: { margin: 0, color: color.mutedForeground, fontSize: text.xxs, lineHeight: leading.xxs },
  action: {
    flexShrink: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: color.primary,
    fontFamily: font.sans,
    fontSize: text.xs,
    fontWeight: 500,
    lineHeight: leading.xs,
    cursor: "pointer",
  },
  consent: { margin: 0, color: color.mutedForeground, fontSize: text.xxs, lineHeight: leading.xxs },
});

const hint = ({ status, actions, subtitle }: ChecklistRow) =>
  status.kind === "needed" && actions.length === 0 ? subtitle : status.text;

export function MeetingsSetup({
  rows,
  consent,
}: {
  rows: readonly ChecklistRow[];
  consent: string;
}) {
  const id = useId();
  const done = rows.filter(settled).length;
  const setupAction = useAction();
  return (
    <section aria-labelledby={id} {...stylex.props(styles.card)}>
      <h2 id={id} {...stylex.props(styles.title)}>
        Set up Meetings
      </h2>
      <ProgressBar label={`${done} of ${rows.length} done`} value={(done / rows.length) * 100} />
      <ul {...stylex.props(styles.list)}>
        {rows.map((row) => {
          const ready = row.status.kind === "ready";
          return (
            <li key={row.id} title={row.subtitle} {...stylex.props(styles.row)}>
              <span
                {...stylex.props(
                  styles.mark,
                  ready && styles.markReady,
                  row.status.kind === "failed" && styles.markFailed,
                )}
              >
                {ready && <CheckIcon size={10} strokeWidth={3} />}
              </span>
              <div {...stylex.props(styles.text)}>
                <p {...stylex.props(styles.label, ready && styles.labelDone)}>{row.title}</p>
                {!ready && <p {...stylex.props(styles.hint)}>{hint(row)}</p>}
              </div>
              {row.actions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  aria-label={`${action.label} ${row.title}`}
                  onClick={() =>
                    void setupAction.run(
                      () => runSetupCommand(action.command),
                      setupFailure(action.label, row.title),
                    )
                  }
                  {...stylex.props(styles.action)}
                >
                  {action.label}
                </button>
              ))}
            </li>
          );
        })}
      </ul>
      {setupAction.error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {setupAction.error}
        </p>
      )}
      <p {...stylex.props(styles.consent)}>{consent}</p>
    </section>
  );
}

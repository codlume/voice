import { Progress } from "@base-ui/react/progress";
import * as stylex from "@stylexjs/stylex";
import { CheckIcon } from "lucide-react";
import { useId } from "react";

import { settled, type ChecklistRow } from "./checklist.ts";
import { runSetupCommand } from "./Home.tsx";
import { color, radius, space } from "./tokens.stylex.ts";

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
    whiteSpace: "normal",
    cursor: "default",
  },
  title: { margin: 0, fontSize: 13, fontWeight: 600 },
  track: {
    height: 4,
    overflow: "hidden",
    borderRadius: radius.round,
    backgroundColor: color.segmentTrack,
  },
  fill: { height: "100%", backgroundColor: color.success },
  list: { display: "flex", flexDirection: "column", gap: 10, margin: 0, padding: 0 },
  row: { display: "flex", alignItems: "flex-start", gap: space.sm, listStyle: "none" },
  mark: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 16,
    height: 16,
    marginTop: 1,
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
  label: { margin: 0, fontSize: 12.5, lineHeight: 1.35 },
  labelDone: { color: color.mutedForeground },
  hint: { margin: 0, color: color.mutedForeground, fontSize: 11.5, lineHeight: 1.35 },
  action: {
    flexShrink: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: color.primary,
    font: "inherit",
    fontSize: 12.5,
    fontWeight: 500,
    cursor: "pointer",
  },
  consent: { margin: 0, color: color.mutedForeground, fontSize: 11.5, lineHeight: 1.4 },
});

/** What a row says under its name: how to do it when nothing else says, else where it stands. */
const hint = ({ status, actions, subtitle }: ChecklistRow) =>
  status.kind === "needed" && actions.length === 0 ? subtitle : status.text;

/** "Set up Meetings" as a compact card, which sits in the sidebar beside the Meetings page. */
export function MeetingsSetup({
  rows,
  consent,
}: {
  rows: readonly ChecklistRow[];
  consent: string;
}) {
  const id = useId();
  const done = rows.filter(settled).length;
  return (
    <section aria-labelledby={id} {...stylex.props(styles.card)}>
      <h2 id={id} {...stylex.props(styles.title)}>
        Set up Meetings
      </h2>
      <Progress.Root aria-label={`${done} of ${rows.length} done`} value={done} max={rows.length}>
        <Progress.Track {...stylex.props(styles.track)}>
          <Progress.Indicator {...stylex.props(styles.fill)} />
        </Progress.Track>
      </Progress.Root>
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
                  onClick={() => void runSetupCommand(action.command)}
                  {...stylex.props(styles.action)}
                >
                  {action.label}
                </button>
              ))}
            </li>
          );
        })}
      </ul>
      <p {...stylex.props(styles.consent)}>{consent}</p>
    </section>
  );
}

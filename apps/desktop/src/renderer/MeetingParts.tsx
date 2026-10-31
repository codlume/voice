import { Tabs } from "@base-ui/react/tabs";
import * as stylex from "@stylexjs/stylex";
import { PauseIcon, PlayIcon } from "lucide-react";
import { memo, useMemo, type ReactNode } from "react";

import type { MeetingControls } from "../shared/api.ts";
import type { Meeting, MeetingPrompt } from "../shared/meetings.ts";
import { Button } from "./Button.tsx";
import { clockTicks, statusClock, statusView, type RecordingCommand } from "./meetingStatus.ts";
import { partialRows, transcriptRows, type TranscriptRow } from "./meetingsView.ts";
import { color, space } from "./tokens.stylex.ts";
import { useMeetingPartials, useMeetingTranscript } from "./useMeetings.ts";
import { useNow } from "./useNow.ts";

// The Voice window's meeting pages and the notepad draw a meeting with these parts. `look` sizes
// them for a page or for the narrow notepad.
type Look = "page" | "notepad";

const styles = stylex.create({
  bar: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: color.border,
  },
  barNotepad: { paddingInline: space.md },
  list: { display: "flex", gap: space.lg },
  listNotepad: { gap: space.md },
  tab: {
    marginBottom: -1,
    paddingBlock: 8,
    paddingInline: 0,
    borderWidth: 0,
    borderBottomWidth: 2,
    borderBottomStyle: "solid",
    borderBottomColor: "transparent",
    backgroundColor: "transparent",
    color: { default: color.mutedForeground, ":hover": color.foreground },
    fontFamily: "inherit",
    fontSize: 14.5,
    cursor: "pointer",
    outline: { default: "none", ":focus-visible": `2px solid ${color["--ring"]}` },
    outlineOffset: 2,
  },
  tabNotepad: { paddingBlock: 6, fontSize: 12.5 },
  tabOn: { borderBottomColor: color.foreground, color: color.foreground, fontWeight: 500 },
  transcript: { margin: 0, padding: 0, listStyle: "none" },
  turn: { paddingTop: { default: space.md, ":first-child": 0 } },
  turnContinued: { paddingTop: 4 },
  speakerLine: { display: "flex", alignItems: "baseline", gap: space.sm },
  speaker: { margin: 0, fontSize: 13, fontWeight: 600 },
  speakerNotepad: { fontSize: 12.5 },
  speakerOthers: { color: color.primary },
  time: { color: color.mutedForeground, fontSize: 12, fontVariantNumeric: "tabular-nums" },
  timeNotepad: { fontSize: 11.5 },
  speech: { margin: 0, fontSize: 15, lineHeight: 1.55 },
  speechNotepad: { fontSize: 13.5, lineHeight: 1.5 },
  partial: { color: color.mutedForeground },
  marker: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    paddingTop: space.md,
    color: color.mutedForeground,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    "::before": { content: "''", flexGrow: 1, height: 1, backgroundColor: color.border },
    "::after": { content: "''", flexGrow: 1, height: 1, backgroundColor: color.border },
  },
  markerNotepad: { fontSize: 11 },
  clock: { fontVariantNumeric: "tabular-nums" },
  controls: { display: "flex", alignItems: "center", gap: 6 },
});

export type TabOption<T extends string> = { value: T; label: string };

/** Underlined tabs over their panels, with `end` at the right of the tab bar. */
export function MeetingTabs<T extends string>({
  tabs,
  value,
  onChange,
  look,
  end,
  style,
  children,
}: {
  tabs: readonly TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  look: Look;
  end?: ReactNode;
  style?: stylex.StyleXStyles;
  children: ReactNode;
}) {
  const notepad = look === "notepad";
  return (
    <Tabs.Root
      value={value}
      onValueChange={(next: unknown) => {
        const found = tabs.find((tab) => tab.value === next);
        if (found) onChange(found.value);
      }}
      {...stylex.props(style)}
    >
      <div {...stylex.props(styles.bar, notepad && styles.barNotepad)}>
        <Tabs.List {...stylex.props(styles.list, notepad && styles.listNotepad)}>
          {tabs.map((tab) => (
            <Tabs.Tab
              key={tab.value}
              value={tab.value}
              {...stylex.props(
                styles.tab,
                notepad && styles.tabNotepad,
                tab.value === value && styles.tabOn,
              )}
            >
              {tab.label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {end}
      </div>
      {children}
    </Tabs.Root>
  );
}

/**
 * The meeting's transcript as it is followed, with each source's unconfirmed text after it.
 * Undefined until the first read lands.
 */
export function useTranscriptRows(
  api: Pick<MeetingControls, "getMeeting" | "onMeetingTranscript" | "onMeetingPartial">,
  meeting: Meeting,
): readonly TranscriptRow[] | undefined {
  const transcript = useMeetingTranscript(api, meeting);
  const partials = useMeetingPartials(api, meeting.id, meeting.status.kind === "recording");
  const { speakers } = meeting;
  // Partials change several times a second; the saved lines only when one is added.
  const saved = useMemo(
    () => transcript && transcriptRows(transcript, speakers),
    [transcript, speakers],
  );
  return useMemo(
    () => (saved ? [...saved, ...partialRows(partials)] : undefined),
    [saved, partials],
  );
}

type SpeechProps = Omit<Extract<TranscriptRow, { kind: "speech" }>, "kind" | "id"> & {
  notepad: boolean;
};

// Memoized on plain values, so a new line renders only itself, not every line before it.
const Speech = memo(function Speech({
  speaker,
  mine,
  time,
  text,
  final,
  continues,
  notepad,
}: SpeechProps) {
  return (
    <li {...stylex.props(styles.turn, continues && styles.turnContinued)}>
      {!continues && (
        <div {...stylex.props(styles.speakerLine)}>
          <p
            {...stylex.props(
              styles.speaker,
              notepad && styles.speakerNotepad,
              !mine && styles.speakerOthers,
            )}
          >
            {speaker}
          </p>
          <span {...stylex.props(styles.time, notepad && styles.timeNotepad)}>{time}</span>
        </div>
      )}
      <p
        {...stylex.props(styles.speech, notepad && styles.speechNotepad, !final && styles.partial)}
      >
        {text}
      </p>
    </li>
  );
});

export function TranscriptList({ rows, look }: { rows: readonly TranscriptRow[]; look: Look }) {
  const notepad = look === "notepad";
  return (
    <ol aria-label="Transcript" {...stylex.props(styles.transcript)}>
      {rows.map(({ id, ...row }) =>
        row.kind === "marker" ? (
          <li key={id} {...stylex.props(styles.marker, notepad && styles.markerNotepad)}>
            {row.text}
          </li>
        ) : (
          <Speech
            key={id}
            speaker={row.speaker}
            mine={row.mine}
            time={row.time}
            text={row.text}
            final={row.final}
            continues={row.continues}
            notepad={notepad}
          />
        ),
      )}
    </ol>
  );
}

/**
 * The recorded length, ticking each second while it records or counts down to the limit. It
 * owns the clock, so only it renders each second, never the transcript beside it.
 */
export function StatusClock({
  meeting,
  prompt = null,
  style,
}: {
  meeting: Meeting;
  prompt?: MeetingPrompt | null;
  style?: stylex.StyleXStyles;
}) {
  const now = useNow(clockTicks(meeting.status, prompt));
  return <time {...stylex.props(styles.clock, style)}>{statusClock(meeting, now)}</time>;
}

// Pause and Resume are icons in the notepad, so the status keeps its room there.
const controlLooks: Record<RecordingCommand, { label: string; icon: ReactNode | null }> = {
  pause: { label: "Pause", icon: <PauseIcon size={16} aria-hidden="true" /> },
  resume: { label: "Resume", icon: <PlayIcon size={16} aria-hidden="true" /> },
  stop: { label: "Stop", icon: null },
};

/** The recording controls the meeting's status offers, the same in every window. */
export function RecordingControls({
  meeting,
  look,
  pending,
  onCommand,
}: {
  meeting: Meeting;
  look: Look;
  pending: boolean;
  onCommand: (command: RecordingCommand) => void;
}) {
  const { controls } = statusView(meeting.status);
  if (controls.length === 0) return null;
  return (
    <div {...stylex.props(styles.controls)}>
      {controls.map((command) => {
        const { label, icon } = controlLooks[command];
        const iconOnly = look === "notepad" && icon !== null;
        return (
          <Button
            key={command}
            variant={iconOnly ? "icon" : command === "stop" ? "primary" : "secondary"}
            aria-label={label}
            title={label}
            disabled={pending}
            onClick={() => onCommand(command)}
          >
            {iconOnly ? icon : label}
          </Button>
        );
      })}
    </div>
  );
}

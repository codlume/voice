import { Tabs } from "@base-ui/react/tabs";
import { Tooltip } from "@base-ui/react/tooltip";
import * as stylex from "@stylexjs/stylex";
import { PauseIcon, PlayIcon } from "lucide-react";
import { memo, useMemo, type ReactNode } from "react";

import type { MeetingControls } from "../shared/api.ts";
import type { Meeting, MeetingPrompt } from "../shared/meetings.ts";
import { Button } from "./Button.tsx";
import { clockTicks, statusClock, statusView, type RecordingCommand } from "./meetingStatus.ts";
import {
  partialRows,
  transcriptRows,
  type SpeakerTone,
  type TranscriptRow,
} from "./meetingsView.ts";
import type { HelpAnchor } from "./help.ts";
import { segmentStyles } from "./ToggleGroup.tsx";
import { color, leading, motion, radius, space, text as size } from "./tokens.stylex.ts";
import { tooltipPopupClass, tooltipPositionerClass } from "./tooltip.ts";
import { useMeetingPartials, useMeetingTranscript, type Read } from "./useMeetings.ts";
import { useNow } from "./useNow.ts";

type Look = "page" | "notepad";

const styles = stylex.create({
  bar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  barNotepad: { paddingBlock: space.sm, paddingInline: space.md },
  tab: { borderWidth: 0, fontFamily: "inherit" },
  tabNotepad: { height: 24, paddingInline: space.sm, fontSize: size.xs, lineHeight: leading.xs },
  transcript: { margin: 0, padding: 0, listStyle: "none" },
  turn: { paddingTop: { default: space.md, ":first-child": 0 } },
  turnContinued: { paddingTop: space.xxs },
  speakerLine: { display: "flex", alignItems: "center", gap: space.sm },
  speaker: {
    margin: 0,
    color: color.foreground,
    fontSize: size.sm,
    fontWeight: 500,
    lineHeight: leading.sm,
  },
  time: {
    color: color.mutedForeground,
    fontSize: size.xs,
    lineHeight: leading.xs,
    fontVariantNumeric: "tabular-nums",
  },
  // The dot and its gap, so speech lines up under the name.
  speech: {
    margin: 0,
    paddingInlineStart: space.base,
    fontSize: size.base,
    lineHeight: leading.base,
  },
  speechNotepad: { fontSize: size.sm, lineHeight: leading.sm },
  partial: { color: color.mutedForeground },
  marker: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    paddingTop: space.md,
    color: color.mutedForeground,
    fontSize: size.xxs,
    fontWeight: 500,
    lineHeight: leading.xxs,
    "::before": { content: "''", flexGrow: 1, height: 1, backgroundColor: color.border },
    "::after": { content: "''", flexGrow: 1, height: 1, backgroundColor: color.border },
  },
  clock: { fontVariantNumeric: "tabular-nums" },
  controls: { display: "flex", alignItems: "center", gap: space.xs },
  stopGlyph: { width: 10, height: 10, borderRadius: 2, backgroundColor: color.error },
  dot: { flexShrink: 0, width: 8, height: 8, borderRadius: radius.round },
});

// Low-chroma hues, a step lighter in dark mode, so a speaker reads apart without looking like a link.
const tones = stylex.create({
  you: { backgroundColor: color.mutedForeground },
  others: { backgroundColor: `color-mix(in srgb, ${color.mutedForeground} 45%, transparent)` },
  voice1: {
    backgroundColor: { default: "oklch(62% 0.09 250)", [motion.dark]: "oklch(72% 0.09 250)" },
  },
  voice2: {
    backgroundColor: { default: "oklch(62% 0.09 155)", [motion.dark]: "oklch(72% 0.09 155)" },
  },
  voice3: {
    backgroundColor: { default: "oklch(66% 0.09 75)", [motion.dark]: "oklch(74% 0.09 75)" },
  },
  voice4: {
    backgroundColor: { default: "oklch(62% 0.09 20)", [motion.dark]: "oklch(72% 0.09 20)" },
  },
  voice5: {
    backgroundColor: { default: "oklch(62% 0.09 305)", [motion.dark]: "oklch(72% 0.09 305)" },
  },
  voice6: {
    backgroundColor: { default: "oklch(62% 0.07 200)", [motion.dark]: "oklch(72% 0.07 200)" },
  },
});

const dot = (tone: SpeakerTone) => (
  <span aria-hidden="true" {...stylex.props(styles.dot, tones[tone])} />
);

export function SpeakerDot({ tone }: { tone: SpeakerTone }) {
  return dot(tone);
}

type TabOption<T extends string> = { value: T; label: string };

/** Segmented tabs over their panels, with `end` at the right of the tab row. */
export function MeetingTabs<T extends string>({
  tabs,
  value,
  onChange,
  look,
  end,
  style,
  help,
  children,
}: {
  tabs: readonly TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  look: Look;
  end?: ReactNode;
  style?: stylex.StyleXStyles;
  help?: HelpAnchor;
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
      <div data-help={help} {...stylex.props(styles.bar, notepad && styles.barNotepad)}>
        <Tabs.List {...stylex.props(segmentStyles.track)}>
          {tabs.map((tab) => (
            <Tabs.Tab
              key={tab.value}
              value={tab.value}
              {...stylex.props(
                segmentStyles.segment,
                styles.tab,
                notepad && styles.tabNotepad,
                tab.value === value && segmentStyles.on,
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
 * The meeting's transcript as it is followed, with each source's unconfirmed text after it. A
 * meeting main no longer has stays `reading`; its page closes once main reports it gone.
 */
export function useTranscriptRows(
  api: Pick<MeetingControls, "getMeeting" | "onMeetingTranscript" | "onMeetingPartial">,
  meeting: Meeting,
): Read<readonly TranscriptRow[]> {
  const transcript = useMeetingTranscript(api, meeting);
  const partials = useMeetingPartials(api, meeting.id, meeting.status.kind === "recording");
  const { speakers } = meeting;
  const saved = useMemo(
    () =>
      transcript.kind === "read" && transcript.value && transcriptRows(transcript.value, speakers),
    [transcript, speakers],
  );
  return useMemo((): Read<readonly TranscriptRow[]> => {
    if (transcript.kind === "failed") return transcript;
    if (!saved) return { kind: "reading" };
    return { kind: "read", value: [...saved, ...partialRows(partials)] };
  }, [transcript, saved, partials]);
}

type SpeechProps = Omit<Extract<TranscriptRow, { kind: "speech" }>, "kind" | "id"> & {
  notepad: boolean;
};

const Speech = memo(function Speech({
  speaker,
  tone,
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
          {/* A plain span, not <SpeakerDot>: a long transcript renders one per turn. */}
          {dot(tone)}
          <p {...stylex.props(styles.speaker)}>{speaker}</p>
          <span {...stylex.props(styles.time)}>{time}</span>
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
          <li key={id} {...stylex.props(styles.marker)}>
            {row.text}
          </li>
        ) : (
          <Speech
            key={id}
            speaker={row.speaker}
            tone={row.tone}
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

const pauseIcons: Record<Exclude<RecordingCommand, "stop">, ReactNode> = {
  pause: <PauseIcon size={16} aria-hidden="true" />,
  resume: <PlayIcon size={16} aria-hidden="true" />,
};

const labels: Record<RecordingCommand, string> = { pause: "Pause", resume: "Resume", stop: "Stop" };

function IconControl({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <Button variant="icon" aria-label={label} disabled={disabled} onClick={onClick}>
            {children}
          </Button>
        }
      />
      <Tooltip.Portal>
        <Tooltip.Positioner side="bottom" sideOffset={4} className={tooltipPositionerClass()}>
          <Tooltip.Popup className={tooltipPopupClass()}>{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** Pause or Resume, then Stop: a quiet button with a red square, never the page's call to action. */
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
      {controls.map((command) =>
        command !== "stop" && look === "notepad" ? (
          <IconControl
            key={command}
            label={labels[command]}
            disabled={pending}
            onClick={() => onCommand(command)}
          >
            {pauseIcons[command]}
          </IconControl>
        ) : (
          <Button
            key={command}
            variant="secondary"
            aria-label={labels[command]}
            disabled={pending}
            onClick={() => onCommand(command)}
          >
            {command === "stop" && <span aria-hidden="true" {...stylex.props(styles.stopGlyph)} />}
            {labels[command]}
          </Button>
        ),
      )}
    </div>
  );
}

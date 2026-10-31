import { Tabs } from "@base-ui/react/tabs";
import * as stylex from "@stylexjs/stylex";
import { PauseIcon, PlayIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { MeetingCommandResult, Meeting, MeetingId, NotepadState } from "../shared/meetings.ts";
import { Button } from "./Button.tsx";
import {
  CONSENT_REMINDER,
  partialRows,
  transcriptRows,
  type TranscriptRow,
} from "./meetingsView.ts";
import {
  notepadStatus,
  notepadTicks,
  promptView,
  type NotepadCommand,
  type RecordingCommand,
} from "./notepadView.ts";
import { pageStyles } from "./pageStyles.ts";
import { color, font, radius, space } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { useMeetingPartials, useMeetingTranscript } from "./useMeetings.ts";
import { useNow } from "./useNow.ts";
import { useThoughts } from "./useThoughts.ts";
import { notepadApi } from "./voice.ts";

const HEADER_HEIGHT = 40;
// Clears the traffic lights main places at x 14.
const TRAFFIC_LIGHTS_INSET = 88;
// Within this many px of the bottom the transcript keeps following new lines.
const FOLLOW_SLACK = 24;

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    backgroundColor: color.background,
    color: color.foreground,
    fontFamily: font.sans,
    fontSize: 13,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    flexShrink: 0,
    height: HEADER_HEIGHT,
    paddingLeft: TRAFFIC_LIGHTS_INSET,
    paddingRight: space.sm,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: color.border,
    WebkitAppRegion: "drag",
    userSelect: "none",
  },
  status: { display: "flex", alignItems: "center", gap: 6, flexGrow: 1, minWidth: 0 },
  light: { flexShrink: 0, width: 8, height: 8, borderRadius: radius.round },
  recording: { backgroundColor: color.error },
  paused: { backgroundColor: color.mutedForeground },
  busy: { backgroundColor: color.mutedForeground, opacity: 0.5 },
  done: { backgroundColor: color.success },
  label: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 },
  clock: { color: color.mutedForeground, fontVariantNumeric: "tabular-nums" },
  controls: { display: "flex", alignItems: "center", gap: 6, WebkitAppRegion: "no-drag" },
  prompt: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    flexShrink: 0,
    margin: space.sm,
    marginBottom: 0,
    padding: space.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.large,
    backgroundColor: color.card,
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.08)",
  },
  promptTitle: { margin: 0, fontSize: 13.5, fontWeight: 600 },
  promptBody: { margin: 0, color: color.mutedForeground, lineHeight: 1.45 },
  promptActions: { display: "flex", justifyContent: "flex-end", gap: 6, paddingTop: 4 },
  tabs: { display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 },
  tabList: {
    display: "grid",
    gridAutoFlow: "column",
    gridAutoColumns: "1fr",
    gap: 2,
    flexShrink: 0,
    margin: space.sm,
    padding: 3,
    borderRadius: radius.medium,
    backgroundColor: color.segmentTrack,
  },
  tab: {
    paddingBlock: 4,
    borderWidth: 0,
    borderRadius: 7,
    backgroundColor: "transparent",
    color: color.mutedForeground,
    fontFamily: "inherit",
    fontSize: 12.5,
    cursor: "pointer",
    outline: { default: "none", ":focus-visible": `2px solid ${color["--ring"]}` },
  },
  tabOn: {
    backgroundColor: color.segmentSelected,
    color: color.foreground,
    fontWeight: 500,
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.1)",
  },
  panel: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    outline: "none",
  },
  scroll: { flexGrow: 1, minHeight: 0, overflowY: "auto", paddingInline: space.md },
  empty: { paddingBlock: space.lg, color: color.mutedForeground, textAlign: "center" },
  emptyLine: { margin: 0 },
  consent: { marginTop: space.sm, fontSize: 12 },
  transcript: { margin: 0, paddingBlock: space.sm, paddingInline: 0, listStyle: "none" },
  turn: { paddingTop: { default: space.md, ":first-child": 0 } },
  turnContinued: { paddingTop: 4 },
  speakerLine: { display: "flex", alignItems: "baseline", gap: space.sm },
  speaker: { margin: 0, fontSize: 12.5, fontWeight: 600 },
  speakerOthers: { color: color.primary },
  time: { color: color.mutedForeground, fontSize: 11.5, fontVariantNumeric: "tabular-nums" },
  speech: { margin: 0, fontSize: 13.5, lineHeight: 1.5 },
  partial: { color: color.mutedForeground },
  marker: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    paddingTop: space.md,
    color: color.mutedForeground,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    "::before": { content: "''", flexGrow: 1, height: 1, backgroundColor: color.border },
    "::after": { content: "''", flexGrow: 1, height: 1, backgroundColor: color.border },
  },
  thoughts: {
    flexGrow: 1,
    width: "100%",
    minHeight: 0,
    padding: space.md,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: color.foreground,
    font: "inherit",
    fontSize: 14,
    lineHeight: 1.55,
    resize: "none",
    outline: "none",
  },
  error: { margin: 0, paddingInline: space.md, paddingBottom: space.sm },
});

type NotepadTab = "transcript" | "thoughts";
const tabs: readonly { value: NotepadTab; label: string }[] = [
  { value: "transcript", label: "Transcript" },
  { value: "thoughts", label: "My thoughts" },
];

// Pause and Resume are icons so the status keeps its room in a narrow notepad.
const controlLooks: Record<RecordingCommand, { label: string; icon: ReactNode | null }> = {
  pause: { label: "Pause", icon: <PauseIcon size={16} aria-hidden="true" /> },
  resume: { label: "Resume", icon: <PlayIcon size={16} aria-hidden="true" /> },
  stop: { label: "Stop", icon: null },
};

/** Undefined until main answers; null once the meeting is gone. */
function useNotepadState(): NotepadState | null | undefined {
  const [state, setState] = useState<NotepadState | null | undefined>(undefined);
  useEffect(() => {
    // As in useMeetings: a push that lands before the answer is newer, so the answer yields.
    const unsubscribe = notepadApi().onNotepad(setState);
    void notepadApi()
      .getNotepad()
      .then((first) => setState((current) => (current === undefined ? first : current)));
    return unsubscribe;
  }, []);
  return state;
}

/** The meeting's transcript as it is followed, with each source's unconfirmed text after it. */
function useLiveTranscript(meeting: Meeting) {
  const transcript = useMeetingTranscript(notepadApi(), meeting);
  const partials = useMeetingPartials(
    notepadApi(),
    meeting.id,
    meeting.status.kind === "recording",
  );
  const { speakers } = meeting;
  return useMemo(
    () => (transcript ? [...transcriptRows(transcript, speakers), ...partialRows(partials)] : null),
    [transcript, speakers, partials],
  );
}

function Transcript({ rows }: { rows: readonly TranscriptRow[] | null }) {
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && rows && following.current) element.scrollTop = element.scrollHeight;
  }, [rows]);
  if (rows === null) return null;
  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
        following.current = scrollHeight - scrollTop - clientHeight <= FOLLOW_SLACK;
      }}
      {...stylex.props(styles.scroll)}
    >
      {rows.length === 0 ? (
        <div {...stylex.props(styles.empty)}>
          <p {...stylex.props(styles.emptyLine)}>What people say shows up here.</p>
          <p {...stylex.props(styles.emptyLine, styles.consent)}>{CONSENT_REMINDER}</p>
        </div>
      ) : (
        <ol aria-label="Transcript" {...stylex.props(styles.transcript)}>
          {rows.map((row) =>
            row.kind === "marker" ? (
              <li key={row.id} {...stylex.props(styles.marker)}>
                {row.text}
              </li>
            ) : (
              <li
                key={row.id}
                {...stylex.props(styles.turn, row.continues && styles.turnContinued)}
              >
                {!row.continues && (
                  <div {...stylex.props(styles.speakerLine)}>
                    <p {...stylex.props(styles.speaker, !row.mine && styles.speakerOthers)}>
                      {row.speaker}
                    </p>
                    <span {...stylex.props(styles.time)}>{row.time}</span>
                  </div>
                )}
                <p {...stylex.props(styles.speech, !row.final && styles.partial)}>{row.text}</p>
              </li>
            ),
          )}
        </ol>
      )}
    </div>
  );
}

function Thoughts({ meeting }: Pick<NotepadState, "meeting">) {
  const thoughts = useThoughts(
    meeting,
    (notes) => notepadApi().updateMeetingNotes(meeting.id, notes),
    "Could not save your thoughts. Keep the notepad open and try again.",
  );
  return (
    <>
      <textarea
        aria-label="My thoughts"
        value={thoughts.text}
        placeholder="Write your thoughts here. The summary never changes them."
        onChange={(event) => thoughts.change(event.target.value)}
        {...stylex.props(styles.thoughts)}
      />
      {thoughts.error && (
        <p role="alert" {...stylex.props(pageStyles.error, styles.error)}>
          {thoughts.error}
        </p>
      )}
    </>
  );
}

function send(command: NotepadCommand, id: MeetingId): Promise<MeetingCommandResult | void> {
  const api = notepadApi();
  switch (command) {
    case "pause":
      return api.pauseMeeting(id);
    case "resume":
      return api.resumeMeeting(id);
    case "stop":
      return api.stopMeeting(id);
    case "keep":
      return api.keepMeeting(id);
    case "discard":
      return api.discardMeeting(id);
    case "dismiss":
      return api.dismissMeetingPrompt();
    case "viewSummary":
      return api.viewMeetingSummary(id);
  }
}

function MeetingNotepad({ meeting, prompt }: NotepadState) {
  // Held here, not in the tab, so lines keep arriving while My thoughts is open.
  const rows = useLiveTranscript(meeting);
  const now = useNow(notepadTicks(meeting, prompt));
  const status = notepadStatus(meeting, now);
  const [tab, setTab] = useState<NotepadTab>("transcript");
  const action = useAction();
  const run = (command: NotepadCommand) =>
    void action.run(async () => {
      const result = await send(command, meeting.id);
      if (result?.kind === "refused") throw new Error(result.message);
    }, "Could not change the recording. Try again.");
  const asked = prompt && promptView(prompt, now);
  return (
    <div {...stylex.props(styles.root)}>
      <header {...stylex.props(styles.header)}>
        <div role="status" {...stylex.props(styles.status)}>
          <span aria-hidden="true" {...stylex.props(styles.light, styles[status.tone])} />
          <span {...stylex.props(styles.label)}>{status.label}</span>
          <time {...stylex.props(styles.clock)}>{status.clock}</time>
        </div>
        <div {...stylex.props(styles.controls)}>
          {status.controls.map((command) => {
            const { label, icon } = controlLooks[command];
            return (
              <Button
                key={command}
                variant={icon ? "icon" : "primary"}
                aria-label={label}
                title={label}
                disabled={action.pending}
                onClick={() => run(command)}
              >
                {icon ?? label}
              </Button>
            );
          })}
        </div>
      </header>
      {asked && (
        <section aria-label={asked.title ?? "Notice"} {...stylex.props(styles.prompt)}>
          {asked.title && <p {...stylex.props(styles.promptTitle)}>{asked.title}</p>}
          <p {...stylex.props(styles.promptBody)}>{asked.body}</p>
          <div {...stylex.props(styles.promptActions)}>
            {asked.actions.map(({ label, command, primary }) => (
              <Button
                key={command}
                variant={primary ? "primary" : "secondary"}
                disabled={action.pending}
                onClick={() => run(command)}
              >
                {label}
              </Button>
            ))}
          </div>
        </section>
      )}
      {action.error && (
        <p role="alert" {...stylex.props(pageStyles.error, styles.error)}>
          {action.error}
        </p>
      )}
      <Tabs.Root
        value={tab}
        onValueChange={(value: unknown) => {
          const next = tabs.find((candidate) => candidate.value === value);
          if (next) setTab(next.value);
        }}
        {...stylex.props(styles.tabs)}
      >
        <Tabs.List {...stylex.props(styles.tabList)}>
          {tabs.map(({ value, label }) => (
            <Tabs.Tab
              key={value}
              value={value}
              {...stylex.props(styles.tab, value === tab && styles.tabOn)}
            >
              {label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <Tabs.Panel value="transcript" {...stylex.props(styles.panel)}>
          <Transcript rows={rows} />
        </Tabs.Panel>
        <Tabs.Panel value="thoughts" {...stylex.props(styles.panel)}>
          <Thoughts meeting={meeting} />
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}

export function Notepad() {
  const state = useNotepadState();
  if (!state) return null;
  // A new meeting starts its transcript, thoughts and tab afresh.
  return <MeetingNotepad key={state.meeting.id} {...state} />;
}

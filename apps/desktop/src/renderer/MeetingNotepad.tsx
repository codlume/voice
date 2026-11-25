import { Tabs } from "@base-ui/react/tabs";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type {
  MeetingCommandResult,
  MeetingId,
  MeetingPrompt,
  NotepadState,
} from "../shared/meetings.ts";
import { Button } from "./Button.tsx";
import {
  MeetingTabs,
  RecordingControls,
  StatusClock,
  TranscriptList,
  useTranscriptRows,
} from "./MeetingParts.tsx";
import { ThoughtsEditor } from "./MeetingThoughts.tsx";
import type { Read } from "./useMeetings.ts";
import { CONSENT_REMINDER, type TranscriptRow } from "./meetingsView.ts";
import { commandRefusal, promptView, statusView, type PromptCommand } from "./meetingStatus.ts";
import { pageStyles } from "./pageStyles.ts";
import { color, font, leading, radius, space, text } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { useNow } from "./useNow.ts";
import { notepadApi } from "./voice.ts";

const HEADER_HEIGHT = 40;
const TRAFFIC_LIGHTS_INSET = 88;
const FOLLOW_SLACK = 24;

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    backgroundColor: color.background,
    color: color.foreground,
    fontFamily: font.sans,
    fontSize: text.sm,
    lineHeight: leading.sm,
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
  status: { display: "flex", alignItems: "center", gap: space.sm, flexGrow: 1, minWidth: 0 },
  light: { flexShrink: 0, width: 8, height: 8, borderRadius: radius.round },
  recording: { backgroundColor: color.error },
  paused: { backgroundColor: color.mutedForeground },
  busy: { backgroundColor: color.mutedForeground, opacity: 0.5 },
  done: { backgroundColor: color.success },
  label: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 },
  clock: { flexShrink: 0, color: color.mutedForeground },
  controls: { WebkitAppRegion: "no-drag" },
  prompt: {
    display: "flex",
    flexDirection: "column",
    gap: space.xxs,
    flexShrink: 0,
    margin: space.sm,
    marginBottom: 0,
    padding: space.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.large,
    backgroundColor: color.muted,
  },
  // Prompts that can stop or discard the recording read as warnings.
  promptWarning: {
    borderColor: `color-mix(in srgb, ${color.warning} 24%, transparent)`,
    backgroundColor: color.warningSurface,
  },
  promptTitle: { margin: 0, fontWeight: 600 },
  promptBody: { margin: 0, color: color.mutedForeground },
  promptActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: space.xs,
    paddingTop: space.xs,
  },
  tabs: { display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 },
  panel: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    outline: { default: "none", ":focus-visible": `2px solid ${color["--ring"]}` },
    outlineOffset: -2,
  },
  scroll: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    paddingBlock: space.sm,
    paddingInline: space.md,
  },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.xs,
    paddingBlock: space.xl,
    paddingInline: space.md,
    textAlign: "center",
    textWrap: "balance",
  },
  emptyLine: { margin: 0, fontWeight: 500 },
  consent: {
    color: color.mutedForeground,
    fontSize: text.xs,
    fontWeight: 400,
    lineHeight: leading.xs,
  },
  retry: { paddingTop: space.xs },
  error: { margin: 0, paddingInline: space.md, paddingBottom: space.sm },
});

type NotepadTab = "transcript" | "thoughts";
const tabs = [
  { value: "transcript", label: "Transcript" },
  { value: "thoughts", label: "My thoughts" },
] as const satisfies readonly { value: NotepadTab; label: string }[];

function useNotepadState(): NotepadState | null | undefined {
  const [state, setState] = useState<NotepadState | null | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = notepadApi().onNotepad(setState);
    void notepadApi()
      .getNotepad()
      .then((first) => setState((current) => (current === undefined ? first : current)));
    return unsubscribe;
  }, []);
  return state;
}

function Transcript({ transcript }: { transcript: Read<readonly TranscriptRow[]> }) {
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const rows = transcript.kind === "read" ? transcript.value : null;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && rows && following.current) element.scrollTop = element.scrollHeight;
  }, [rows]);
  if (transcript.kind === "failed") {
    return (
      <div {...stylex.props(styles.empty)}>
        <p {...stylex.props(styles.emptyLine)}>Could not load the transcript.</p>
        <div {...stylex.props(styles.retry)}>
          <Button variant="secondary" onClick={transcript.retry}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (!rows) return null;
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
        <TranscriptList rows={rows} look="notepad" />
      )}
    </div>
  );
}

function Prompt({
  prompt,
  pending,
  onAnswer,
}: {
  prompt: MeetingPrompt;
  pending: boolean;
  onAnswer: (command: PromptCommand) => void;
}) {
  const now = useNow(prompt.kind === "maxLengthSoon");
  const asked = promptView(prompt, now);
  return (
    <section
      aria-label={asked.title ?? "Notice"}
      {...stylex.props(styles.prompt, prompt.kind !== "summaryReady" && styles.promptWarning)}
    >
      {asked.title && <p {...stylex.props(styles.promptTitle)}>{asked.title}</p>}
      <p {...stylex.props(styles.promptBody)}>{asked.body}</p>
      <div {...stylex.props(styles.promptActions)}>
        {asked.actions.map(({ label, command, primary }) => (
          <Button
            key={command}
            variant={primary ? "primary" : "secondary"}
            disabled={pending}
            onClick={() => onAnswer(command)}
          >
            {label}
          </Button>
        ))}
      </div>
    </section>
  );
}

async function send(command: PromptCommand, id: MeetingId): Promise<MeetingCommandResult | null> {
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
      await api.dismissMeetingPrompt();
      return null;
    case "viewSummary":
      await api.viewMeetingSummary(id);
      return null;
  }
}

function MeetingNotepad({ meeting, prompt }: NotepadState) {
  const transcript = useTranscriptRows(notepadApi(), meeting);
  const status = statusView(meeting.status);
  const [tab, setTab] = useState<NotepadTab>("transcript");
  const action = useAction();
  const run = (command: PromptCommand) =>
    void action.run(async () => {
      const result = await send(command, meeting.id);
      const refusal = result && commandRefusal(result);
      if (refusal) throw new Error(refusal);
    }, "Could not change the recording. Try again.");
  return (
    <div {...stylex.props(styles.root)}>
      <header data-drag-region {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.status)}>
          <span aria-hidden="true" {...stylex.props(styles.light, styles[status.tone])} />
          <span role="status" {...stylex.props(styles.label)}>
            {status.label}
          </span>
          <StatusClock meeting={meeting} prompt={prompt} style={styles.clock} />
        </div>
        <div {...stylex.props(styles.controls)}>
          <RecordingControls
            meeting={meeting}
            look="notepad"
            pending={action.pending}
            onCommand={run}
          />
        </div>
      </header>
      {prompt && <Prompt prompt={prompt} pending={action.pending} onAnswer={run} />}
      {action.error && (
        <p role="alert" {...stylex.props(pageStyles.error, styles.error)}>
          {action.error}
        </p>
      )}
      <MeetingTabs tabs={tabs} value={tab} onChange={setTab} look="notepad" style={styles.tabs}>
        <Tabs.Panel value="transcript" {...stylex.props(styles.panel)}>
          <Transcript transcript={transcript} />
        </Tabs.Panel>
        <Tabs.Panel value="thoughts" {...stylex.props(styles.panel)}>
          <ThoughtsEditor
            meeting={meeting}
            save={(notes) => notepadApi().updateMeetingNotes(meeting.id, notes)}
            look="notepad"
          />
        </Tabs.Panel>
      </MeetingTabs>
    </div>
  );
}

export function Notepad() {
  const state = useNotepadState();
  if (!state) return null;
  return <MeetingNotepad key={state.meeting.id} {...state} />;
}

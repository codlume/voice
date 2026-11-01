import { Tabs } from "@base-ui/react/tabs";
import * as stylex from "@stylexjs/stylex";
import { ChevronLeftIcon, CopyIcon, DownloadIcon, FolderPlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";

import {
  closedMs,
  isLive,
  titleText,
  type Folder,
  type Meeting,
  type MeetingBanner,
  type MeetingId,
  type Speaker,
  type Summary,
} from "../shared/meetings.ts";
import { shownSummary } from "../shared/meeting-markdown.ts";
import { a11y } from "./a11y.ts";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import type { ChecklistRow } from "./checklist.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { SetupChecklist } from "./Home.tsx";
import { FolderMenu } from "./MeetingList.tsx";
import { MeetingNotices } from "./MeetingNotices.tsx";
import {
  MeetingTabs,
  RecordingControls,
  TranscriptList,
  useTranscriptRows,
} from "./MeetingParts.tsx";
import { ThoughtsEditor } from "./MeetingThoughts.tsx";
import { SummaryMarkdown } from "./MeetingSummary.tsx";
import { durationLabel, meetingWhen, summaryNotice } from "./meetingsView.ts";
import {
  commandRefusal,
  promptView,
  statusLabel,
  type PromptCommand,
  type RecordingCommand,
} from "./meetingStatus.ts";
import { pageStyles } from "./pageStyles.ts";
import { color, radius, space } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.lg },
  // The page column is wide for the list and its panel; a note reads better at the usual width.
  readable: { maxWidth: 800, marginInline: "auto" },
  back: { alignSelf: "flex-start" },
  header: { display: "flex", alignItems: "flex-start", gap: space.md },
  heading: { display: "flex", flexDirection: "column", gap: 6, flexGrow: 1, minWidth: 0 },
  titleInput: {
    width: "100%",
    padding: 0,
    marginInline: -6,
    paddingInline: 6,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: "transparent", ":hover": color.accent, ":focus": color.accent },
    color: color.foreground,
    font: "inherit",
    outline: "none",
  },
  when: { margin: 0, color: color.mutedForeground, fontSize: 13.5 },
  actions: { display: "flex", alignItems: "center", gap: 2, paddingTop: 6 },
  iconButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: "transparent", ":hover": color.accent },
    color: color.mutedForeground,
    cursor: "pointer",
  },
  iconButtonOpen: { backgroundColor: color.accent, color: color.foreground },
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    outline: { default: "none", ":focus-visible": `2px solid ${color["--ring"]}` },
    outlineOffset: 3,
  },
  banner: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    paddingBlock: 10,
    paddingInline: space.md,
  },
  bannerText: { margin: 0, flexGrow: 1, fontSize: 13.5 },
  bannerError: { color: color.errorForeground },
  muted: { margin: 0, color: color.mutedForeground },
  summaryCard: { padding: space.lg },
  stale: { opacity: 0.6 },
  speakers: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.sm,
    margin: 0,
    padding: space.lg,
    paddingBottom: 0,
    borderWidth: 0,
  },
  speakerInput: {
    width: 140,
    paddingBlock: 4,
    paddingInline: 8,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: color.border, ":focus": color.input },
    borderRadius: radius.small,
    backgroundColor: "transparent",
    color: color.primary,
    font: "inherit",
    fontSize: 13,
    fontWeight: 600,
    outline: "none",
  },
  transcript: { padding: space.lg },
});

type DetailTab = "summary" | "thoughts" | "transcript";
const tabs = [
  { value: "summary", label: "Summary" },
  { value: "thoughts", label: "My thoughts" },
  { value: "transcript", label: "Transcript" },
] as const satisfies readonly { value: DetailTab; label: string }[];

/**
 * A field that saves on Enter or on leaving it and goes back to `saved` on Escape. While it has
 * focus the draft stays, so a name main writes meanwhile does not replace what the user types.
 */
function DraftInput({
  saved,
  save,
  style,
  ...input
}: {
  saved: string;
  save: (text: string) => void;
  style: stylex.StyleXStyles;
} & Pick<InputHTMLAttributes<HTMLInputElement>, "aria-label" | "placeholder">) {
  const [draft, setDraft] = useState<string | null>(null);
  // Escape blurs too, and the blur must not save what Escape threw away.
  const reverting = useRef(false);
  return (
    <input
      {...input}
      value={draft ?? saved}
      spellCheck={false}
      onFocus={() => setDraft(saved)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (!reverting.current && draft !== null && draft.trim() !== saved) save(draft);
        reverting.current = false;
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") reverting.current = true;
        if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
      }}
      {...stylex.props(style)}
    />
  );
}

function TitleField({ meeting }: { meeting: Meeting }) {
  const action = useAction();
  return (
    <>
      <h1 {...stylex.props(pageStyles.headline)}>
        <DraftInput
          aria-label="Meeting title"
          placeholder="Untitled meeting"
          saved={meeting.title ?? ""}
          save={(title) =>
            void action.run(
              () => hubApi().renameMeeting(meeting.id, title),
              "Could not rename this meeting.",
            )
          }
          style={styles.titleInput}
        />
      </h1>
      {action.error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {action.error}
        </p>
      )}
    </>
  );
}

function SummaryCard({
  summary,
  speakers,
  dimmed = false,
}: {
  summary: Summary;
  speakers: readonly Speaker[];
  dimmed?: boolean;
}) {
  return (
    <Card style={[styles.summaryCard, dimmed && styles.stale]}>
      <SummaryMarkdown markdown={summary.markdown} speakers={speakers} />
    </Card>
  );
}

function Banner({
  text,
  error = false,
  action,
}: {
  text: string;
  error?: boolean;
  action?: { label: string; onClick: () => void; disabled: boolean } | null;
}) {
  return (
    <Card style={styles.banner}>
      <p {...stylex.props(styles.bannerText, error && styles.bannerError)}>{text}</p>
      {action && (
        <Button variant="secondary" disabled={action.disabled} onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </Card>
  );
}

type PageCommand = RecordingCommand | Extract<PromptCommand, "keep" | "discard">;

/** The page's side of "Started by mistake?", in the notepad's words. */
function ShortRecording({
  pending,
  onCommand,
}: {
  pending: boolean;
  onCommand: (command: PageCommand) => void;
}) {
  const { title, body, actions } = promptView({ kind: "startedByMistake" }, 0);
  return (
    <Card style={styles.banner}>
      <p {...stylex.props(styles.bannerText)}>
        {title} {body}
      </p>
      {actions.map(
        ({ label, command, primary }) =>
          (command === "keep" || command === "discard") && (
            <Button
              key={command}
              variant={primary ? "primary" : "secondary"}
              disabled={pending}
              onClick={() => onCommand(command)}
            >
              {label}
            </Button>
          ),
      )}
    </Card>
  );
}

const noticeActions = {
  generate: "Generate summary",
  retry: "Try again",
  update: "Update summary",
} as const;

function SummaryPanel({
  meeting,
  summaryModel,
}: {
  meeting: Meeting;
  summaryModel: ChecklistRow | null;
}) {
  const action = useAction();
  const notice = summaryNotice(meeting);
  const shown = shownSummary(meeting);
  const generate = () =>
    void action.run(async () => {
      const refusal = commandRefusal(await hubApi().generateMeetingSummary(meeting.id));
      if (refusal) throw new Error(refusal);
    }, "Could not start the summary.");
  return (
    <>
      {summaryModel && meeting.summary.kind !== "ready" && (
        <SetupChecklist title="Summaries" rows={[summaryModel]} counted={false} />
      )}
      {notice && (
        <Banner
          text={notice.text}
          error={notice.error}
          action={
            notice.action && {
              label: noticeActions[notice.action],
              onClick: generate,
              disabled: action.pending,
            }
          }
        />
      )}
      {action.error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {action.error}
        </p>
      )}
      {shown && (
        <SummaryCard
          summary={shown}
          speakers={meeting.speakers}
          dimmed={meeting.status.kind === "summarizing"}
        />
      )}
    </>
  );
}

/** A speaker's name; blank goes back to "Speaker N". */
function SpeakerField({ meetingId, speaker }: { meetingId: MeetingId; speaker: Speaker }) {
  const action = useAction();
  return (
    <>
      <DraftInput
        aria-label={`Name for ${speaker.label}`}
        placeholder={speaker.label}
        saved={speaker.name ?? ""}
        save={(name) =>
          void action.run(
            () => hubApi().renameMeetingSpeaker(meetingId, speaker.id, name),
            "Could not rename this speaker.",
          )
        }
        style={styles.speakerInput}
      />
      {action.error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {action.error}
        </p>
      )}
    </>
  );
}

function Transcript({ meeting }: { meeting: Meeting }) {
  const rows = useTranscriptRows(hubApi(), meeting);
  if (!rows) return null;
  if (rows.length === 0) {
    return (
      <Card style={styles.summaryCard}>
        <p {...stylex.props(styles.muted)}>No transcript yet.</p>
      </Card>
    );
  }
  return (
    <Card>
      {meeting.speakers.length > 0 && (
        <fieldset aria-label="Speakers" {...stylex.props(styles.speakers)}>
          {meeting.speakers.map((speaker) => (
            <SpeakerField key={speaker.id} meetingId={meeting.id} speaker={speaker} />
          ))}
        </fieldset>
      )}
      <div {...stylex.props(styles.transcript)}>
        <TranscriptList rows={rows} look="page" />
      </div>
    </Card>
  );
}

const feedbackText = { copied: "Copied as Markdown", saved: "Saved" } as const;

export function MeetingDetail({
  meeting,
  folders,
  notices,
  summaryModel,
  onBack,
}: {
  meeting: Meeting;
  folders: readonly Folder[];
  /** This meeting's notices. */
  notices: readonly MeetingBanner[];
  /** The summary model's row while it is not on disk, else null. */
  summaryModel: ChecklistRow | null;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>("summary");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [feedback, setFeedback] = useState<keyof typeof feedbackText | null>(null);
  const action = useAction();
  const status = statusLabel(meeting);
  const when = [meetingWhen(meeting), status ?? durationLabel(closedMs(meeting))];
  const recording = useAction();
  const command = (name: PageCommand) =>
    void recording.run(async () => {
      const api = hubApi();
      const send = {
        pause: api.pauseMeeting,
        resume: api.resumeMeeting,
        stop: api.stopMeeting,
        keep: api.keepMeeting,
        discard: api.discardMeeting,
      };
      const refusal = commandRefusal(await send[name](meeting.id));
      if (refusal) throw new Error(refusal);
    }, "Could not change the recording. Try again.");

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 1500);
    return () => clearTimeout(timer);
  }, [feedback]);

  const copy = () =>
    void action.run(async () => {
      await hubApi().copyMeetingMarkdown(meeting.id);
      setFeedback("copied");
    }, "Could not copy this meeting.");
  const exportFile = () =>
    void action.run(async () => {
      if ((await hubApi().exportMeetingMarkdown(meeting.id)) === "saved") setFeedback("saved");
    }, "Could not export this meeting.");
  const remove = () =>
    void action.run(async () => {
      await hubApi().deleteMeeting(meeting.id);
      onBack();
    }, "Could not delete this meeting.");

  return (
    <div {...stylex.props(styles.page, styles.readable)}>
      <div {...stylex.props(styles.back)}>
        <Button variant="text" onClick={onBack}>
          <ChevronLeftIcon size={14} aria-hidden="true" />
          All meetings
        </Button>
      </div>
      <div {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.heading)}>
          <TitleField meeting={meeting} />
          <p {...stylex.props(styles.when)}>{when.join(" · ")}</p>
        </div>
        <div {...stylex.props(styles.actions)}>
          <RecordingControls
            meeting={meeting}
            look="page"
            pending={recording.pending}
            onCommand={command}
          />
          <FolderMenu
            meeting={meeting}
            folders={folders}
            label="Move to folder"
            style={(open) => [styles.iconButton, open && styles.iconButtonOpen]}
          >
            <FolderPlusIcon size={16} />
          </FolderMenu>
          <Button
            variant="icon"
            aria-label="Copy as Markdown"
            title="Copy as Markdown"
            onClick={copy}
          >
            <CopyIcon size={16} />
          </Button>
          <Button variant="icon" aria-label="Export .md" title="Export .md" onClick={exportFile}>
            <DownloadIcon size={16} />
          </Button>
          {!isLive(meeting) && (
            <Button
              variant="icon"
              aria-label="Delete meeting"
              title="Delete meeting"
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2Icon size={16} />
            </Button>
          )}
        </div>
      </div>
      {[action.error, recording.error].map(
        (error) =>
          error && (
            <p key={error} role="alert" {...stylex.props(pageStyles.error)}>
              {error}
            </p>
          ),
      )}
      <p role="status" {...stylex.props(feedback ? styles.muted : a11y.visuallyHidden)}>
        {feedback && feedbackText[feedback]}
      </p>
      <MeetingNotices notices={notices} onViewSummary={() => setTab("summary")} />
      {meeting.status.kind === "confirmingShort" && (
        <ShortRecording pending={recording.pending} onCommand={command} />
      )}
      <MeetingTabs tabs={tabs} value={tab} onChange={setTab} look="page" style={styles.page}>
        <Tabs.Panel value="summary" {...stylex.props(styles.panel)}>
          <SummaryPanel meeting={meeting} summaryModel={summaryModel} />
        </Tabs.Panel>
        <Tabs.Panel value="thoughts" {...stylex.props(styles.panel)}>
          <ThoughtsEditor
            key={meeting.id}
            meeting={meeting}
            save={(notes) => hubApi().updateMeetingNotes(meeting.id, notes)}
            look="page"
          />
        </Tabs.Panel>
        <Tabs.Panel value="transcript" {...stylex.props(styles.panel)}>
          <Transcript meeting={meeting} />
        </Tabs.Panel>
      </MeetingTabs>
      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Delete “${titleText(meeting)}”?`}
        description="Its transcript, summary and your thoughts are deleted from this Mac. This cannot be undone."
        actions={[{ label: "Delete", variant: "destructive", onClick: remove }]}
      />
    </div>
  );
}

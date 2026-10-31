import { Tabs } from "@base-ui/react/tabs";
import * as stylex from "@stylexjs/stylex";
import { ChevronLeftIcon, CopyIcon, DownloadIcon, FolderPlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  recordedMs,
  summarizesOnStop,
  summaryStale,
  titleText,
  type Folder,
  type Meeting,
  type MeetingBanner,
  type MeetingCommandResult,
  type MeetingId,
  type Speaker,
  type Summary,
  type TranscriptEntry,
} from "../shared/meetings.ts";
import { a11y } from "./a11y.ts";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import type { ChecklistRow } from "./checklist.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { SetupChecklist } from "./Home.tsx";
import { FolderMenu } from "./MeetingList.tsx";
import { MeetingNotices } from "./MeetingNotices.tsx";
import { SummaryMarkdown } from "./MeetingSummary.tsx";
import {
  durationLabel,
  meetingWhen,
  partialRows,
  statusLabel,
  transcriptRows,
} from "./meetingsView.ts";
import { pageStyles } from "./pageStyles.ts";
import { color, radius, space } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { useMeetingPartials, useMeetingTranscript } from "./useMeetings.ts";
import { useThoughts } from "./useThoughts.ts";
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
  tabList: {
    display: "inline-grid",
    alignSelf: "flex-start",
    gridAutoFlow: "column",
    gap: 2,
    padding: 3,
    borderRadius: radius.medium,
    backgroundColor: color.segmentTrack,
  },
  tab: {
    paddingBlock: 6,
    paddingInline: space.md,
    borderWidth: 0,
    borderRadius: 7,
    backgroundColor: "transparent",
    color: color.mutedForeground,
    fontFamily: "inherit",
    fontSize: 13,
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
  thoughts: {
    width: "100%",
    minHeight: 280,
    padding: space.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: color.border, ":focus": color.input },
    borderRadius: radius.large,
    backgroundColor: color.card,
    color: color.foreground,
    font: "inherit",
    fontSize: 15,
    lineHeight: 1.6,
    resize: "vertical",
    outline: "none",
  },
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
  transcript: { margin: 0, padding: space.lg, listStyle: "none" },
  turn: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    columnGap: space.md,
    paddingTop: { default: space.md, ":first-child": 0 },
  },
  turnContinued: { paddingTop: 4 },
  speaker: { margin: 0, fontSize: 13, fontWeight: 600 },
  speakerOthers: { color: color.primary },
  time: {
    color: color.mutedForeground,
    fontSize: 12,
    fontVariantNumeric: "tabular-nums",
  },
  speech: { gridColumn: "1 / -1", margin: 0, fontSize: 15, lineHeight: 1.55 },
  partial: { color: color.mutedForeground, fontStyle: "italic" },
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
});

type DetailTab = "summary" | "thoughts" | "transcript";
const tabs: readonly { value: DetailTab; label: string }[] = [
  { value: "summary", label: "Summary" },
  { value: "thoughts", label: "My thoughts" },
  { value: "transcript", label: "Transcript" },
];

/** Says why a summary command did nothing, or null when it went ahead. */
const summaryRefusal = (result: MeetingCommandResult) =>
  result.kind === "refused" ? result.message : null;

function TitleField({ meeting }: { meeting: Meeting }) {
  const saved = meeting.title?.text ?? "";
  const [draft, setDraft] = useState(saved);
  const action = useAction();
  const commit = () => {
    if (draft.trim() === saved) return;
    void action.run(
      () => hubApi().renameMeeting(meeting.id, draft),
      "Could not rename this meeting.",
    );
  };
  return (
    <>
      <h1 {...stylex.props(pageStyles.headline)}>
        <input
          aria-label="Meeting title"
          value={draft}
          placeholder="Untitled meeting"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(saved);
              event.currentTarget.blur();
            }
          }}
          {...stylex.props(styles.titleInput)}
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
  action?: { label: string; onClick: () => void; disabled: boolean };
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

function SummaryPanel({
  meeting,
  summaryModel,
}: {
  meeting: Meeting;
  summaryModel: ChecklistRow | null;
}) {
  const { speakers } = meeting;
  const action = useAction();
  const generate = (label: string) => ({
    label,
    disabled: action.pending,
    onClick: () =>
      void action.run(async () => {
        const refusal = summaryRefusal(await hubApi().generateMeetingSummary(meeting.id));
        if (refusal) throw new Error(refusal);
      }, "Could not start the summary."),
  });
  const { summary, status } = meeting;
  const previous =
    summary.kind === "ready"
      ? summary.summary
      : summary.kind === "failed"
        ? summary.previous
        : null;
  const short = "Short meetings get a summary only when you ask for one.";
  const notice = (() => {
    if (status.kind === "summarizing") return <Banner text="Writing the summary…" />;
    if (status.kind === "transcribing" && summary.kind === "none") {
      return (
        <Banner
          text={
            summarizesOnStop(meeting)
              ? "The summary is written once the transcript is final."
              : short
          }
        />
      );
    }
    if (status.kind !== "ready") {
      return <Banner text="The summary is written when the meeting ends." />;
    }
    if (summary.kind === "failed") {
      return (
        <Banner
          error
          text={`The summary could not be written. ${summary.message}`}
          action={generate("Try again")}
        />
      );
    }
    if (summary.kind === "none") {
      return (
        <Banner
          text={summarizesOnStop(meeting) ? "This meeting has no summary yet." : short}
          action={generate("Generate summary")}
        />
      );
    }
    if (summaryStale(meeting)) {
      return (
        <Banner text="New recording since this summary." action={generate("Update summary")} />
      );
    }
    return null;
  })();
  return (
    <>
      {summaryModel && summary.kind !== "ready" && (
        <SetupChecklist title="Summaries" rows={[summaryModel]} counted={false} />
      )}
      {notice}
      {action.error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {action.error}
        </p>
      )}
      {previous && (
        <SummaryCard
          summary={previous}
          speakers={speakers}
          dimmed={status.kind === "summarizing"}
        />
      )}
    </>
  );
}

function Thoughts({ meeting }: { meeting: Meeting }) {
  const thoughts = useThoughts(
    meeting,
    (notes) => hubApi().updateMeetingNotes(meeting.id, notes),
    "Could not save your thoughts. Keep this page open and try again.",
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
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {thoughts.error}
        </p>
      )}
    </>
  );
}

/** A speaker's name, saved on Enter or leaving the field; blank goes back to "Speaker N". */
function SpeakerField({ meetingId, speaker }: { meetingId: MeetingId; speaker: Speaker }) {
  const saved = speaker.name?.text ?? "";
  const [draft, setDraft] = useState(saved);
  const action = useAction();
  const commit = () => {
    if (draft.trim() === saved) return;
    void action.run(
      () => hubApi().renameMeetingSpeaker(meetingId, speaker.id, draft),
      "Could not rename this speaker.",
    );
  };
  return (
    <>
      <input
        aria-label={`Name for ${speaker.label}`}
        value={draft}
        placeholder={speaker.label}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(saved);
            event.currentTarget.blur();
          }
        }}
        {...stylex.props(styles.speakerInput)}
      />
      {action.error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {action.error}
        </p>
      )}
    </>
  );
}

function Transcript({
  meeting,
  transcript,
}: {
  meeting: Meeting;
  transcript: readonly TranscriptEntry[] | null | undefined;
}) {
  const partials = useMeetingPartials(hubApi(), meeting.id, meeting.status.kind === "recording");
  if (!transcript) return null;
  const rows = [...transcriptRows(transcript, meeting.speakers), ...partialRows(partials)];
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
            <SpeakerField
              key={`${speaker.id}:${speaker.name?.text ?? ""}`}
              meetingId={meeting.id}
              speaker={speaker}
            />
          ))}
        </fieldset>
      )}
      <ol aria-label="Transcript" {...stylex.props(styles.transcript)}>
        {rows.map((row) =>
          row.kind === "marker" ? (
            <li key={row.id} {...stylex.props(styles.marker)}>
              {row.text}
            </li>
          ) : (
            <li key={row.id} {...stylex.props(styles.turn, row.continues && styles.turnContinued)}>
              {!row.continues && (
                <>
                  <p {...stylex.props(styles.speaker, !row.mine && styles.speakerOthers)}>
                    {row.speaker}
                  </p>
                  <span {...stylex.props(styles.time)}>{row.time}</span>
                </>
              )}
              <p {...stylex.props(styles.speech, !row.final && styles.partial)}>{row.text}</p>
            </li>
          ),
        )}
      </ol>
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
  const transcript = useMeetingTranscript(hubApi(), meeting);
  const [tab, setTab] = useState<DetailTab>("summary");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [feedback, setFeedback] = useState<keyof typeof feedbackText | null>(null);
  const action = useAction();
  const status = statusLabel(meeting);
  // Without a status word the meeting is ready, so it has no open leg for `now` to count.
  const when = [meetingWhen(meeting), status ?? durationLabel(recordedMs(meeting, 0))];

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
          <TitleField key={meeting.title?.text ?? ""} meeting={meeting} />
          <p {...stylex.props(styles.when)}>{when.join(" · ")}</p>
        </div>
        <div {...stylex.props(styles.actions)}>
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
          <Button
            variant="icon"
            aria-label="Delete meeting"
            title="Delete meeting"
            onClick={() => setConfirmingDelete(true)}
          >
            <Trash2Icon size={16} />
          </Button>
        </div>
      </div>
      {action.error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {action.error}
        </p>
      )}
      <p role="status" {...stylex.props(feedback ? styles.muted : a11y.visuallyHidden)}>
        {feedback && feedbackText[feedback]}
      </p>
      <MeetingNotices notices={notices} />
      <Tabs.Root
        value={tab}
        onValueChange={(value: unknown) => {
          const next = tabs.find((candidate) => candidate.value === value);
          if (next) setTab(next.value);
        }}
        {...stylex.props(styles.page)}
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
        <Tabs.Panel value="summary" {...stylex.props(styles.panel)}>
          <SummaryPanel meeting={meeting} summaryModel={summaryModel} />
        </Tabs.Panel>
        <Tabs.Panel value="thoughts" {...stylex.props(styles.panel)}>
          <Thoughts key={meeting.id} meeting={meeting} />
        </Tabs.Panel>
        <Tabs.Panel value="transcript" {...stylex.props(styles.panel)}>
          <Transcript meeting={meeting} transcript={transcript} />
        </Tabs.Panel>
      </Tabs.Root>
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

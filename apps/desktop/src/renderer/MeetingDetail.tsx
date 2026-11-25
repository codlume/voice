import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Tabs } from "@base-ui/react/tabs";
import { Tooltip } from "@base-ui/react/tooltip";
import * as stylex from "@stylexjs/stylex";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  FolderIcon,
  FolderPlusIcon,
  MoreHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
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
import { FolderDialog } from "./FolderDialog.tsx";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./Menu.tsx";
import { SetupChecklist } from "./SetupChecklist.tsx";
import { MeetingNotices } from "./MeetingNotices.tsx";
import {
  MeetingTabs,
  RecordingControls,
  SpeakerDot,
  TranscriptList,
  useTranscriptRows,
} from "./MeetingParts.tsx";
import { ThoughtsEditor } from "./MeetingThoughts.tsx";
import { SummaryMarkdown } from "./MeetingSummary.tsx";
import { durationLabel, meetingWhen, speakerToneAt, summaryNotice } from "./meetingsView.ts";
import {
  commandRefusal,
  promptView,
  statusLabel,
  type PromptCommand,
  type RecordingCommand,
} from "./meetingStatus.ts";
import { pageStyles } from "./pageStyles.ts";
import { Skeleton } from "./Skeleton.tsx";
import { surfaces } from "./surfaces.ts";
import { color, icon, leading, motion, radius, space, text as size } from "./tokens.stylex.ts";
import { tooltipPopupClass, tooltipPositionerClass } from "./tooltip.ts";
import { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.lg },
  readable: { maxWidth: 800, marginInline: "auto" },
  back: { alignSelf: "flex-start" },
  header: { display: "flex", alignItems: "flex-start", gap: space.md },
  heading: { display: "flex", flexDirection: "column", gap: space.xs, flexGrow: 1, minWidth: 0 },
  titleInput: {
    width: "100%",
    padding: 0,
    marginInline: `calc(-1 * ${space.xs})`,
    paddingInline: space.xs,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: "transparent", ":hover": color.accent, ":focus": color.accent },
    color: color.foreground,
    font: "inherit",
    outline: "none",
  },
  when: {
    margin: 0,
    color: color.mutedForeground,
    fontSize: size.sm,
    lineHeight: leading.sm,
    fontVariantNumeric: "tabular-nums",
  },
  actions: { display: "flex", alignItems: "center", gap: space.xs },
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
    paddingBlock: space.sm,
    paddingInline: space.md,
    backgroundColor: color.muted,
    boxShadow: "none",
  },
  bannerWarning: {
    borderColor: `color-mix(in srgb, ${color.warning} 24%, transparent)`,
    backgroundColor: color.warningSurface,
  },
  bannerError: {
    borderColor: `color-mix(in srgb, ${color.error} 24%, transparent)`,
    backgroundColor: color.errorSurface,
  },
  bannerText: { margin: 0, flexGrow: 1, fontSize: size.sm, lineHeight: leading.sm },
  bannerTextError: { color: color.errorForeground },
  bannerTitle: { fontWeight: 600 },
  muted: { margin: 0, color: color.mutedForeground, fontSize: size.sm, lineHeight: leading.sm },
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
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.xs,
    height: 28,
    paddingInline: space.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: color.border, ":focus-within": color["--ring"] },
    borderRadius: radius.round,
    backgroundColor: { default: "transparent", ":hover": color.accent },
    boxShadow: {
      default: "none",
      ":focus-within": `0 0 0 3px color-mix(in srgb, ${color["--ring"]} 24%, transparent)`,
    },
    cursor: "text",
    transitionProperty: "box-shadow, border-color, background-color",
    transitionDuration: { default: motion.base, [motion.reduced]: "0s" },
  },
  chipInput: {
    fieldSizing: "content",
    minWidth: "1ch",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: color.foreground,
    font: "inherit",
    fontSize: size.sm,
    fontWeight: 500,
    lineHeight: leading.sm,
    outline: "none",
    "::placeholder": { color: color.mutedForeground },
  },
  transcript: { padding: space.lg },
  loading: { display: "flex", flexDirection: "column", gap: space.lg, padding: space.lg },
  loadingTurn: { display: "flex", flexDirection: "column", gap: space.sm },
  menuCheck: { display: "flex", flexShrink: 0, width: icon.md, color: color.mutedForeground },
  menuLabel: { flexGrow: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  menuEnd: { display: "flex", color: color.mutedForeground },
  menuEmpty: { margin: 0 },
});

type DetailTab = "summary" | "thoughts" | "transcript";
const tabs = [
  { value: "summary", label: "Summary" },
  { value: "thoughts", label: "My thoughts" },
  { value: "transcript", label: "Transcript" },
] as const satisfies readonly { value: DetailTab; label: string }[];

function DraftInput({
  saved,
  save,
  style,
  ...input
}: {
  saved: string;
  save: (text: string) => Promise<boolean>;
  style: stylex.StyleXStyles;
} & Pick<InputHTMLAttributes<HTMLInputElement>, "aria-label" | "placeholder">) {
  const [draft, setDraft] = useState<string | null>(null);
  const reverting = useRef(false);
  return (
    <input
      {...input}
      value={draft ?? saved}
      spellCheck={false}
      onFocus={() => setDraft((current) => current ?? saved)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const text = draft;
        if (reverting.current || text === null || text.trim() === saved) setDraft(null);
        else {
          void save(text).then((ok) => {
            if (ok) setDraft((current) => (current === text ? null : current));
          });
        }
        reverting.current = false;
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
            action.run(
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
    <Card style={[styles.banner, error && styles.bannerError]}>
      <p {...stylex.props(styles.bannerText, error && styles.bannerTextError)}>{text}</p>
      {action && (
        <Button variant="secondary" disabled={action.disabled} onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </Card>
  );
}

type PageCommand = RecordingCommand | Extract<PromptCommand, "keep" | "discard">;

function ShortRecording({
  pending,
  onCommand,
}: {
  pending: boolean;
  onCommand: (command: PageCommand) => void;
}) {
  const { title, body, actions } = promptView({ kind: "startedByMistake" }, 0);
  return (
    <Card style={[styles.banner, styles.bannerWarning]}>
      <p {...stylex.props(styles.bannerText)}>
        <span {...stylex.props(styles.bannerTitle)}>{title}</span> {body}
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

function SpeakerChip({
  meetingId,
  speaker,
  index,
}: {
  meetingId: MeetingId;
  speaker: Speaker;
  index: number;
}) {
  const action = useAction();
  return (
    <>
      <label {...stylex.props(styles.chip)}>
        <SpeakerDot tone={speakerToneAt(index)} />
        <DraftInput
          aria-label={`Name for ${speaker.label}`}
          placeholder={speaker.label}
          saved={speaker.name ?? ""}
          save={(name) =>
            action.run(
              () => hubApi().renameMeetingSpeaker(meetingId, speaker.id, name),
              "Could not rename this speaker.",
            )
          }
          style={styles.chipInput}
        />
      </label>
      {action.error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {action.error}
        </p>
      )}
    </>
  );
}

const loadingTurns = ["a", "b", "c", "d", "e", "f"] as const;

function TranscriptSkeleton() {
  return (
    <Card>
      <div aria-busy="true" {...stylex.props(styles.loading)}>
        {loadingTurns.map((turn) => (
          <div key={turn} {...stylex.props(styles.loadingTurn)}>
            <Skeleton width="96px" height="12px" />
            <Skeleton height="14px" />
            <Skeleton width="64%" height="14px" />
          </div>
        ))}
      </div>
    </Card>
  );
}

function Transcript({ meeting }: { meeting: Meeting }) {
  const transcript = useTranscriptRows(hubApi(), meeting);
  if (transcript.kind === "failed") {
    return (
      <Banner
        text="Could not load the transcript."
        error
        action={{ label: "Try again", onClick: transcript.retry, disabled: false }}
      />
    );
  }
  if (transcript.kind === "reading") return <TranscriptSkeleton />;
  const rows = transcript.value;
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
          {meeting.speakers.map((speaker, index) => (
            <SpeakerChip key={speaker.id} meetingId={meeting.id} speaker={speaker} index={index} />
          ))}
        </fieldset>
      )}
      <div {...stylex.props(styles.transcript)}>
        <TranscriptList rows={rows} look="page" />
      </div>
    </Card>
  );
}

const menuItemClass = ({ highlighted }: { highlighted: boolean }) =>
  stylex.props(surfaces.item, highlighted && surfaces.itemHighlighted).className;

/** The folders a meeting is in, as checkboxes, and a way to make one with the meeting in it. */
function FolderSubmenu({
  meeting,
  folders,
  onToggle,
  onCreate,
}: {
  meeting: Meeting;
  folders: readonly Folder[];
  onToggle: (folder: Folder, inFolder: boolean) => void;
  onCreate: () => void;
}) {
  return (
    <MenuPrimitive.SubmenuRoot>
      <MenuPrimitive.SubmenuTrigger className={menuItemClass}>
        <span {...stylex.props(styles.menuCheck)}>
          <FolderIcon size={16} aria-hidden="true" />
        </span>
        <span {...stylex.props(styles.menuLabel)}>Move to folder</span>
        <span {...stylex.props(styles.menuEnd)}>
          <ChevronRightIcon size={14} aria-hidden="true" />
        </span>
      </MenuPrimitive.SubmenuTrigger>
      <MenuPopup>
        {folders.length === 0 && (
          <p {...stylex.props(surfaces.groupLabel, styles.menuEmpty)}>No folders yet</p>
        )}
        {folders.map((folder) => (
          <MenuPrimitive.CheckboxItem
            key={folder.id}
            checked={meeting.folderIds.includes(folder.id)}
            onCheckedChange={(checked) => onToggle(folder, checked)}
            className={menuItemClass}
          >
            <span {...stylex.props(styles.menuCheck)}>
              <MenuPrimitive.CheckboxItemIndicator>
                <CheckIcon size={14} aria-hidden="true" />
              </MenuPrimitive.CheckboxItemIndicator>
            </span>
            <span {...stylex.props(styles.menuLabel)}>{folder.name}</span>
          </MenuPrimitive.CheckboxItem>
        ))}
        <MenuSeparator />
        <MenuPrimitive.Item onClick={onCreate} className={menuItemClass}>
          <span {...stylex.props(styles.menuCheck)}>
            <FolderPlusIcon size={16} aria-hidden="true" />
          </span>
          <span {...stylex.props(styles.menuLabel)}>New folder…</span>
        </MenuPrimitive.Item>
      </MenuPopup>
    </MenuPrimitive.SubmenuRoot>
  );
}

function MoreActions({
  meeting,
  folders,
  onToggleFolder,
  onCreateFolder,
  onCopy,
  onExport,
  onDelete,
}: {
  meeting: Meeting;
  folders: readonly Folder[];
  onToggleFolder: (folder: Folder, inFolder: boolean) => void;
  onCreateFolder: () => void;
  onCopy: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  return (
    <Menu>
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <MenuTrigger
              render={
                <Button variant="icon" aria-label="More actions">
                  <MoreHorizontalIcon size={16} aria-hidden="true" />
                </Button>
              }
            />
          }
        />
        <Tooltip.Portal>
          <Tooltip.Positioner side="bottom" sideOffset={4} className={tooltipPositionerClass()}>
            <Tooltip.Popup className={tooltipPopupClass()}>More actions</Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
      <MenuPopup align="end">
        <MenuItem icon={<CopyIcon size={16} aria-hidden="true" />} onClick={onCopy}>
          Copy as Markdown
        </MenuItem>
        <MenuItem icon={<DownloadIcon size={16} aria-hidden="true" />} onClick={onExport}>
          Export .md
        </MenuItem>
        <FolderSubmenu
          meeting={meeting}
          folders={folders}
          onToggle={onToggleFolder}
          onCreate={onCreateFolder}
        />
        {!isLive(meeting) && (
          <>
            <MenuSeparator />
            <MenuItem
              icon={<Trash2Icon size={16} aria-hidden="true" />}
              destructive
              onClick={onDelete}
            >
              Delete meeting
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
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
  notices: readonly MeetingBanner[];
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
  const [creatingFolder, setCreatingFolder] = useState(false);
  // A retry after a failed move adds the meeting to the folder already made, not a second one.
  const madeFolder = useRef<Folder | null>(null);
  const toggleFolder = (folder: Folder, inFolder: boolean) =>
    void action.run(
      () => hubApi().setMeetingInFolder(meeting.id, folder.id, inFolder),
      "Could not change this meeting's folders.",
    );

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
          <MoreActions
            meeting={meeting}
            folders={folders}
            onToggleFolder={toggleFolder}
            onCreateFolder={() => {
              madeFolder.current = null;
              setCreatingFolder(true);
            }}
            onCopy={copy}
            onExport={exportFile}
            onDelete={() => setConfirmingDelete(true)}
          />
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
      {creatingFolder && (
        <FolderDialog
          folder={null}
          open={creatingFolder}
          onOpenChange={setCreatingFolder}
          save={async (draft) => {
            madeFolder.current ??= await hubApi().createFolder(draft);
            await hubApi().setMeetingInFolder(meeting.id, madeFolder.current.id, true);
          }}
        />
      )}
    </div>
  );
}

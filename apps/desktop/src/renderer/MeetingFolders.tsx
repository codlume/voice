import { Field } from "@base-ui/react/field";
import * as stylex from "@stylexjs/stylex";
import {
  ChevronLeftIcon,
  FolderIcon,
  FolderPlusIcon,
  PencilIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import type { DayKey } from "../shared/insights.ts";
import type { Folder, FolderId, MeetingId, MeetingsState } from "../shared/meetings.ts";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { FolderDialog } from "./FolderDialog.tsx";
import { MeetingList } from "./MeetingList.tsx";
import { meetingDays } from "./meetingsView.ts";
import { pageStyles } from "./pageStyles.ts";
import { Switch } from "./Switch.tsx";
import { color, radius, space } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.md },
  bar: { display: "flex", alignItems: "center", gap: space.md },
  auto: { display: "flex", alignItems: "center", gap: space.sm, flexGrow: 1 },
  autoLabel: { fontSize: 13, color: color.mutedForeground, cursor: "pointer" },
  list: { margin: 0, padding: 0, listStyle: "none" },
  row: {
    display: "grid",
    gridTemplateColumns: "36px minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: space.md,
    paddingBlock: 10,
    paddingInline: space.md,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  icon: {
    display: "grid",
    placeItems: "center",
    width: 36,
    height: 36,
    borderRadius: radius.small,
    backgroundColor: color.segmentTrack,
    color: color.mutedForeground,
  },
  body: { display: "flex", flexDirection: "column", minWidth: 0 },
  name: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: color.foreground,
    font: "inherit",
    fontSize: 15,
    textAlign: "left",
    cursor: "pointer",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  detail: { color: color.mutedForeground, fontSize: 13 },
  actions: { display: "flex", alignItems: "center", gap: 2 },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.sm,
    paddingBlock: space.xl,
    paddingInline: space.lg,
    textAlign: "center",
  },
  emptyTitle: { margin: 0, fontSize: 15, fontWeight: 500 },
  emptyBody: { margin: 0, maxWidth: 380, color: color.mutedForeground },
  back: { alignSelf: "flex-start" },
  folderHead: { display: "flex", flexDirection: "column", gap: 2 },
  folderTitle: { margin: 0, fontSize: 17, fontWeight: 600 },
});

const ruleText = (folder: Folder) =>
  folder.kind === "auto" ? `Automatic: title contains “${folder.rule.text}”` : "Manual";

const countText = (count: number) => (count === 1 ? "1 meeting" : `${count} meetings`);

type Editing = { open: boolean; folder: Folder | null };
type Deleting = { open: boolean; folder: Folder };

export function MeetingFolders({
  state: { meetings, folders, settings: meetingsSettings },
  today,
  selectedId,
  onSelect,
  onOpen,
}: {
  state: MeetingsState;
  today: DayKey;
  selectedId: MeetingId | null;
  onSelect: (id: MeetingId) => void;
  onOpen: (id: MeetingId) => void;
}) {
  const [openId, setOpenId] = useState<FolderId | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const action = useAction();
  const inFolder = (folder: Folder) =>
    meetings.filter(({ folderIds }) => folderIds.includes(folder.id));
  const open = folders.find(({ id }) => id === openId);

  const dialogs = (
    <>
      {editing && (
        <FolderDialog
          folder={editing.folder}
          open={editing.open}
          onOpenChange={(next) => setEditing({ ...editing, open: next })}
          save={async (draft) => {
            if (editing.folder) await hubApi().updateFolder(editing.folder.id, draft);
            else await hubApi().createFolder(draft);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          open={deleting.open}
          onOpenChange={(next) => setDeleting({ ...deleting, open: next })}
          title={`Delete the folder “${deleting.folder.name}”?`}
          description="Only the folder is deleted. Its meetings stay."
          actions={[
            {
              label: "Delete folder",
              variant: "destructive",
              onClick: () =>
                void action.run(async () => {
                  await hubApi().deleteFolder(deleting.folder.id);
                  if (openId === deleting.folder.id) setOpenId(null);
                }, "Could not delete this folder."),
            },
          ]}
        />
      )}
      {action.error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {action.error}
        </p>
      )}
    </>
  );

  if (open) {
    const days = meetingDays(inFolder(open), today);
    return (
      <div {...stylex.props(styles.page)}>
        <div {...stylex.props(styles.back)}>
          <Button variant="text" onClick={() => setOpenId(null)}>
            <ChevronLeftIcon size={14} aria-hidden="true" />
            All folders
          </Button>
        </div>
        <div {...stylex.props(styles.bar)}>
          <div {...stylex.props(styles.folderHead, styles.auto)}>
            <h2 {...stylex.props(styles.folderTitle)}>{open.name}</h2>
            <span {...stylex.props(styles.detail)}>{ruleText(open)}</span>
          </div>
          <Button variant="secondary" onClick={() => setEditing({ open: true, folder: open })}>
            Edit
          </Button>
        </div>
        {days.length === 0 ? (
          <Card>
            <div {...stylex.props(styles.empty)}>
              <p {...stylex.props(styles.emptyBody)}>
                {open.kind === "auto"
                  ? `Meetings with “${open.rule.text}” in the title show up here.`
                  : "Add a meeting from its row in Past notes."}
              </p>
            </div>
          </Card>
        ) : (
          <MeetingList
            days={days}
            folders={folders}
            snippets={null}
            selectedId={selectedId}
            onSelect={onSelect}
            onOpen={onOpen}
          />
        )}
        {dialogs}
      </div>
    );
  }

  return (
    <div {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.bar)}>
        <Field.Root {...stylex.props(styles.auto)}>
          <Switch
            id="folders-auto"
            checked={meetingsSettings.autoFolders}
            onChange={(autoFolders) =>
              void action.run(
                () => hubApi().updateMeetingsSettings({ autoFolders }),
                "Could not change automatic folders.",
              )
            }
          />
          <Field.Label {...stylex.props(styles.autoLabel)}>Automatic folders</Field.Label>
        </Field.Root>
        <Button variant="secondary" onClick={() => setEditing({ open: true, folder: null })}>
          <FolderPlusIcon size={14} aria-hidden="true" />
          New folder
        </Button>
      </div>
      {folders.length === 0 ? (
        <Card>
          <div {...stylex.props(styles.empty)}>
            <p {...stylex.props(styles.emptyTitle)}>No folders yet</p>
            <p {...stylex.props(styles.emptyBody)}>
              Folders keep related meetings together. An automatic folder collects every meeting
              with a word in its title.
            </p>
          </div>
        </Card>
      ) : (
        <Card>
          <ul aria-label="Folders" {...stylex.props(styles.list)}>
            {folders.map((folder) => (
              <li key={folder.id} {...stylex.props(styles.row)}>
                <span aria-hidden="true" {...stylex.props(styles.icon)}>
                  {folder.kind === "auto" ? <SparklesIcon size={16} /> : <FolderIcon size={16} />}
                </span>
                <div {...stylex.props(styles.body)}>
                  <button
                    type="button"
                    onClick={() => setOpenId(folder.id)}
                    {...stylex.props(styles.name)}
                  >
                    {folder.name}
                  </button>
                  <span {...stylex.props(styles.detail)}>
                    {countText(inFolder(folder).length)} · {ruleText(folder)}
                  </span>
                </div>
                <div {...stylex.props(styles.actions)}>
                  <Button
                    variant="icon"
                    aria-label={`Edit folder ${folder.name}`}
                    title="Edit"
                    onClick={() => setEditing({ open: true, folder })}
                  >
                    <PencilIcon size={15} />
                  </Button>
                  <Button
                    variant="icon"
                    aria-label={`Delete folder ${folder.name}`}
                    title="Delete"
                    onClick={() => setDeleting({ open: true, folder })}
                  >
                    <Trash2Icon size={15} />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {dialogs}
    </div>
  );
}

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
import { EmptyState } from "./EmptyState.tsx";
import { FolderDialog } from "./FolderDialog.tsx";
import { MeetingList } from "./MeetingList.tsx";
import { meetingDays } from "./meetingsView.ts";
import { pageStyles } from "./pageStyles.ts";
import { Switch } from "./Switch.tsx";
import { color, font, leading, motion, space, text } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.md },
  bar: { display: "flex", alignItems: "center", gap: space.md },
  auto: { display: "flex", alignItems: "center", gap: space.sm, flexGrow: 1 },
  autoLabel: {
    color: color.mutedForeground,
    fontSize: text.sm,
    lineHeight: leading.sm,
    cursor: "pointer",
  },
  // Rows tint on hover, so the card clips them to its corners.
  clip: { overflow: "hidden" },
  list: { margin: 0, padding: 0, listStyle: "none" },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    minHeight: 44,
    paddingBlock: space.sm,
    paddingInlineStart: space.base,
    paddingInlineEnd: space.sm,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: `color-mix(in srgb, ${color.border} 50%, transparent)`,
    backgroundColor: { default: "transparent", ":hover": color.accent },
    transitionProperty: "background-color",
    transitionDuration: { default: motion.fast, [motion.reduced]: "0s" },
  },
  icon: { display: "flex", flexShrink: 0, color: color.mutedForeground },
  body: { display: "flex", flexDirection: "column", gap: 2, flexGrow: 1, minWidth: 0 },
  name: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: color.foreground,
    fontFamily: font.sans,
    fontSize: text.sm,
    fontWeight: 500,
    lineHeight: leading.sm,
    textAlign: "left",
    cursor: "pointer",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  detail: {
    color: color.mutedForeground,
    fontSize: text.xs,
    lineHeight: leading.xs,
    fontVariantNumeric: "tabular-nums",
  },
  actions: { display: "flex", alignItems: "center", gap: space.xxs },
  emptyBody: {
    margin: 0,
    paddingBlock: space.xl,
    paddingInline: space.lg,
    color: color.mutedForeground,
    fontSize: text.sm,
    lineHeight: leading.sm,
    textAlign: "center",
  },
  back: { alignSelf: "flex-start" },
  folderHead: { display: "flex", flexDirection: "column", gap: 2 },
  folderTitle: { margin: 0, fontSize: text.lg, fontWeight: 600, lineHeight: leading.lg },
});

const ruleText = (folder: Folder) =>
  folder.kind === "auto" ? `Automatic: title contains “${folder.rule.text}”` : "Manual";

const countText = (count: number) => (count === 1 ? "1 meeting" : `${count} meetings`);

type Editing = { open: boolean; folder: Folder | null; key: string };
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
  const edit = (folder: Folder | null) =>
    setEditing({ open: true, folder, key: crypto.randomUUID() });

  const dialogs = (
    <>
      {editing && (
        <FolderDialog
          key={editing.key}
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
          <Button variant="secondary" onClick={() => edit(open)}>
            Edit
          </Button>
        </div>
        {days.length === 0 ? (
          <Card>
            <p {...stylex.props(styles.emptyBody)}>
              {open.kind === "auto"
                ? `Meetings with “${open.rule.text}” in the title show up here.`
                : "Add a meeting from its row in Past notes."}
            </p>
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
        <Button variant="secondary" onClick={() => edit(null)}>
          <FolderPlusIcon size={16} aria-hidden="true" />
          New folder
        </Button>
      </div>
      {folders.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FolderIcon size={16} />}
            title="No folders yet"
            description="Folders keep related meetings together. An automatic folder collects every meeting with a word in its title."
          />
        </Card>
      ) : (
        <Card style={styles.clip}>
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
                    onClick={() => edit(folder)}
                  >
                    <PencilIcon size={16} />
                  </Button>
                  <Button
                    variant="icon"
                    aria-label={`Delete folder ${folder.name}`}
                    title="Delete"
                    onClick={() => setDeleting({ open: true, folder })}
                  >
                    <Trash2Icon size={16} />
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

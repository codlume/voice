import { Menu } from "@base-ui/react/menu";
import * as stylex from "@stylexjs/stylex";
import { CheckIcon, FileTextIcon, FolderPlusIcon } from "lucide-react";
import { useState, type MouseEvent, type ReactNode } from "react";

import {
  titleText,
  type Folder,
  type Meeting,
  type MeetingId,
  type MeetingSnippet,
} from "../shared/meetings.ts";
import { Card } from "./Card.tsx";
import { FolderDialog } from "./FolderDialog.tsx";
import { timeLabel } from "./historyView.ts";
import { meetingAt, statusLabel, type MeetingDay } from "./meetingsView.ts";
import { color, font, radius, space } from "./tokens.stylex.ts";
import { pageStyles } from "./pageStyles.ts";
import { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";

const reducedMotion = "@media (prefers-reduced-motion: reduce)";

const menuStyles = stylex.create({
  positioner: { zIndex: 10 },
  popup: {
    minWidth: "14rem",
    maxWidth: "var(--available-width)",
    maxHeight: "min(320px, var(--available-height))",
    overflowY: "auto",
    padding: 4,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.medium,
    backgroundColor: color.card,
    color: color.foreground,
    boxShadow: "0 8px 24px rgb(0 0 0 / 12%)",
    fontFamily: font.sans,
    fontSize: 13,
    lineHeight: 1.45,
    outline: "none",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    minHeight: 30,
    paddingBlock: 5,
    paddingInline: space.sm,
    borderRadius: radius.small,
    cursor: "pointer",
    userSelect: "none",
    outline: "none",
  },
  highlighted: { backgroundColor: color.input },
  check: { flexShrink: 0, width: 14 },
  label: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  separator: { height: 1, marginBlock: 4, backgroundColor: color.border },
  empty: { margin: 0, paddingBlock: 5, paddingInline: space.sm, color: color.mutedForeground },
});

const styles = stylex.create({
  days: { display: "flex", flexDirection: "column", gap: space.lg },
  day: { display: "flex", flexDirection: "column", gap: space.sm },
  dayLabel: {
    margin: 0,
    color: color.mutedForeground,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: "0.075em",
    textTransform: "uppercase",
  },
  // Clips the selected row's background to the card's corners.
  card: { overflow: "hidden" },
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
    cursor: "pointer",
  },
  rowSelected: { backgroundColor: color.accent },
  docIcon: {
    display: "grid",
    placeItems: "center",
    width: 36,
    height: 36,
    borderRadius: radius.small,
    backgroundColor: color.segmentTrack,
    color: color.mutedForeground,
  },
  body: { display: "flex", flexDirection: "column", minWidth: 0 },
  title: {
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
  meta: {
    display: "flex",
    gap: space.sm,
    color: color.mutedForeground,
    fontSize: 13,
    fontVariantNumeric: "tabular-nums",
  },
  status: { color: color.primary },
  snippet: {
    margin: 0,
    marginTop: 2,
    color: color.mutedForeground,
    fontSize: 13,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  where: { color: color.foreground },
  match: { backgroundColor: "transparent", color: color.foreground, fontWeight: 600 },
  folderButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 28,
    paddingInline: 10,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: color.input,
    borderRadius: radius.small,
    backgroundColor: { default: "transparent", ":hover": color.card },
    color: color.mutedForeground,
    font: "inherit",
    fontSize: 12.5,
    cursor: "pointer",
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover")]: 1,
      [stylex.when.ancestor(":focus-within")]: 1,
    },
    transitionProperty: "opacity",
    transitionDuration: { default: "150ms", [reducedMotion]: "0s" },
  },
  folderButtonOpen: { opacity: 1 },
});

/** Adds the meeting to folders or takes it out, and can make a new folder with it inside. */
export function FolderMenu({
  meeting,
  folders,
  label,
  style,
  children,
}: {
  meeting: Meeting;
  folders: readonly Folder[];
  label: string;
  style: (open: boolean) => stylex.StyleXStyles;
  children: ReactNode;
}) {
  const action = useAction();
  const [creating, setCreating] = useState(false);
  const itemClass = ({ highlighted }: Menu.Item.State) =>
    stylex.props(menuStyles.item, highlighted && menuStyles.highlighted).className;
  const toggle = (folder: Folder, inFolder: boolean) =>
    void action.run(
      () => hubApi().setMeetingInFolder(meeting.id, folder.id, inFolder),
      "Could not change this meeting's folders.",
    );
  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          aria-label={label}
          title={label}
          className={({ open }) => stylex.props(style(open)).className}
        >
          {children}
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            side="bottom"
            align="end"
            sideOffset={4}
            collisionPadding={8}
            {...stylex.props(menuStyles.positioner)}
          >
            <Menu.Popup {...stylex.props(menuStyles.popup)}>
              {folders.length === 0 && <p {...stylex.props(menuStyles.empty)}>No folders yet</p>}
              {folders.map((folder) => {
                const inFolder = meeting.folderIds.includes(folder.id);
                return (
                  <Menu.CheckboxItem
                    key={folder.id}
                    checked={inFolder}
                    onCheckedChange={(checked) => toggle(folder, checked)}
                    className={itemClass}
                  >
                    <span {...stylex.props(menuStyles.check)}>
                      <Menu.CheckboxItemIndicator>
                        <CheckIcon size={14} />
                      </Menu.CheckboxItemIndicator>
                    </span>
                    <span {...stylex.props(menuStyles.label)}>{folder.name}</span>
                  </Menu.CheckboxItem>
                );
              })}
              <Menu.Separator {...stylex.props(menuStyles.separator)} />
              <Menu.Item onClick={() => setCreating(true)} className={itemClass}>
                <span {...stylex.props(menuStyles.check)} />
                New folder…
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {creating && (
        <FolderDialog
          folder={null}
          open={creating}
          onOpenChange={setCreating}
          save={async (draft) => {
            const folder = await hubApi().createFolder(draft);
            await hubApi().setMeetingInFolder(meeting.id, folder.id, true);
          }}
        />
      )}
      {action.error && (
        <span role="alert" {...stylex.props(pageStyles.error)}>
          {action.error}
        </span>
      )}
    </>
  );
}

function Row({
  meeting,
  folders,
  snippet,
  selected,
  onSelect,
  onOpen,
}: {
  meeting: Meeting;
  folders: readonly Folder[];
  snippet: { where: string | null; text: MeetingSnippet } | undefined;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const status = statusLabel(meeting);
  const at = meetingAt(meeting);
  // Clicks in the folder menu and dialog bubble here through their portals, outside the row.
  const open = (event: MouseEvent<HTMLLIElement>) => {
    const { target, currentTarget } = event;
    if (!(target instanceof Element) || !currentTarget.contains(target)) return;
    if (!target.closest("button")) onOpen();
  };
  return (
    <li
      onClick={open}
      onPointerEnter={onSelect}
      onFocus={onSelect}
      {...stylex.props(stylex.defaultMarker(), styles.row, selected && styles.rowSelected)}
    >
      <span aria-hidden="true" {...stylex.props(styles.docIcon)}>
        <FileTextIcon size={16} />
      </span>
      <div {...stylex.props(styles.body)}>
        <button type="button" onClick={onOpen} {...stylex.props(styles.title)}>
          {titleText(meeting)}
        </button>
        <span {...stylex.props(styles.meta)}>
          <time dateTime={new Date(at).toISOString()}>{timeLabel(at)}</time>
          {status && <span {...stylex.props(styles.status)}>{status}</span>}
        </span>
        {snippet && (
          <p {...stylex.props(styles.snippet)}>
            {snippet.where && <span {...stylex.props(styles.where)}>{snippet.where}: </span>}
            {snippet.text.before}
            <mark {...stylex.props(styles.match)}>{snippet.text.match}</mark>
            {snippet.text.after}
          </p>
        )}
      </div>
      <FolderMenu
        meeting={meeting}
        folders={folders}
        label={`Add “${titleText(meeting)}” to a folder`}
        style={(menuOpen) => [styles.folderButton, menuOpen && styles.folderButtonOpen]}
      >
        <FolderPlusIcon size={14} />
        Add to folder
      </FolderMenu>
    </li>
  );
}

/** Meetings grouped by day, with the search snippet under a row that `snippets` has one for. */
export function MeetingList({
  days,
  folders,
  snippets,
  selectedId,
  onSelect,
  onOpen,
}: {
  days: readonly MeetingDay[];
  folders: readonly Folder[];
  snippets: ReadonlyMap<MeetingId, { where: string | null; text: MeetingSnippet }> | null;
  selectedId: MeetingId | null;
  onSelect: (id: MeetingId) => void;
  onOpen: (id: MeetingId) => void;
}) {
  return (
    <div {...stylex.props(styles.days)}>
      {days.map((day) => (
        <section key={day.day} aria-label={day.label} {...stylex.props(styles.day)}>
          <h3 {...stylex.props(styles.dayLabel)}>{day.label}</h3>
          <Card style={styles.card}>
            <ul {...stylex.props(styles.list)}>
              {day.meetings.map((meeting) => (
                <Row
                  key={meeting.id}
                  meeting={meeting}
                  folders={folders}
                  snippet={snippets?.get(meeting.id)}
                  selected={meeting.id === selectedId}
                  onSelect={() => onSelect(meeting.id)}
                  onOpen={() => onOpen(meeting.id)}
                />
              ))}
            </ul>
          </Card>
        </section>
      ))}
    </div>
  );
}

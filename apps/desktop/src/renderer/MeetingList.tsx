import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import * as stylex from "@stylexjs/stylex";
import { CheckIcon, FolderPlusIcon } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

import {
  closedMs,
  titleText,
  type Folder,
  type Meeting,
  type MeetingId,
  type MeetingSnippet,
} from "../shared/meetings.ts";
import { Badge } from "./Badge.tsx";
import { Card } from "./Card.tsx";
import { FolderDialog } from "./FolderDialog.tsx";
import { timeLabel } from "./historyView.ts";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./Menu.tsx";
import { durationLabel, meetingAt, type MeetingDay } from "./meetingsView.ts";
import { statusLabel } from "./meetingStatus.ts";
import { surfaces } from "./surfaces.ts";
import { color, font, icon, leading, motion, space, text } from "./tokens.stylex.ts";
import { pageStyles } from "./pageStyles.ts";
import { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";
import { helpAnchor } from "./help.ts";

const menuStyles = stylex.create({
  check: { display: "flex", flexShrink: 0, width: icon.md },
  label: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  empty: {
    margin: 0,
    paddingBlock: space.xxs,
    paddingInline: space.sm,
    color: color.mutedForeground,
  },
});

const styles = stylex.create({
  days: { display: "flex", flexDirection: "column", gap: space.lg },
  day: { display: "flex", flexDirection: "column", gap: space.sm },
  dayLabel: {
    margin: 0,
    paddingInline: space.xxs,
    color: color.mutedForeground,
    fontSize: text.xs,
    fontWeight: 500,
    lineHeight: leading.xs,
  },
  // Rows tint on hover, so the card clips them to its corners.
  card: { overflow: "hidden" },
  list: { margin: 0, padding: 0, listStyle: "none" },
  // Adapted list row (MIT, see THIRD_PARTY_NOTICES.md): hairline-divided rows that tint on hover.
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    minHeight: 44,
    paddingBlock: space.sm,
    paddingInline: space.base,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: `color-mix(in srgb, ${color.border} 50%, transparent)`,
    backgroundColor: { default: "transparent", ":hover": color.accent },
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: { default: motion.fast, [motion.reduced]: "0s" },
  },
  rowSelected: { backgroundColor: color.accent },
  body: { display: "flex", flexDirection: "column", gap: 2, flexGrow: 1, minWidth: 0 },
  title: {
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
  meta: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    minWidth: 0,
    overflow: "hidden",
    color: color.mutedForeground,
    fontSize: text.xs,
    lineHeight: leading.xs,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  snippet: {
    margin: 0,
    color: color.mutedForeground,
    fontSize: text.xs,
    lineHeight: leading.xs,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  where: { color: color.foreground },
  match: { backgroundColor: "transparent", color: color.foreground, fontWeight: 600 },
  // Shown on hover and focus only, but kept in the layout so the row's controls stay named.
  folderButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.xs,
    flexShrink: 0,
    height: 28,
    paddingInline: space.sm,
    fontFamily: font.sans,
    fontSize: text.xs,
    fontWeight: 500,
    lineHeight: leading.xs,
    cursor: "pointer",
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover")]: 1,
      [stylex.when.ancestor(":focus-within")]: 1,
    },
    transitionProperty: "opacity",
    transitionDuration: { default: motion.base, [motion.reduced]: "0s" },
  },
  folderButtonOpen: { opacity: 1 },
});

const SHOWN_FOLDERS = 2;

/** The meeting's first folders by name, then a count of the rest. */
function FolderBadges({ meeting, folders }: { meeting: Meeting; folders: readonly Folder[] }) {
  const inFolders = folders.filter(({ id }) => meeting.folderIds.includes(id));
  const more = inFolders.length - SHOWN_FOLDERS;
  return (
    <>
      {inFolders.slice(0, SHOWN_FOLDERS).map((folder) => (
        <Badge key={folder.id}>{folder.name}</Badge>
      ))}
      {more > 0 && <Badge>{`+${more}`}</Badge>}
    </>
  );
}

const itemClass = ({ highlighted }: MenuPrimitive.CheckboxItem.State) =>
  stylex.props(surfaces.item, highlighted && surfaces.itemHighlighted).className;

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
  const made = useRef<Folder | null>(null);
  // Every meeting row has this menu, and Base UI's is costly to mount, so a plain button stands in
  // until the pointer or focus reaches it, before any press. The real trigger takes the focus over.
  const [menu, setMenu] = useState<{ open: boolean; focus: boolean } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (menu?.focus) trigger.current?.focus();
  }, [menu]);
  const toggle = (folder: Folder, inFolder: boolean) =>
    void action.run(
      () => hubApi().setMeetingInFolder(meeting.id, folder.id, inFolder),
      "Could not change this meeting's folders.",
    );
  return (
    <>
      {menu === null ? (
        <button
          type="button"
          aria-label={label}
          title={label}
          aria-haspopup="menu"
          aria-expanded={false}
          className={stylex.props(style(false)).className}
          onPointerEnter={() => setMenu({ open: false, focus: false })}
          onFocus={() => setMenu({ open: false, focus: true })}
          onClick={() => setMenu({ open: true, focus: false })}
        >
          {children}
        </button>
      ) : (
        <Menu defaultOpen={menu.open}>
          <MenuTrigger
            ref={trigger}
            aria-label={label}
            title={label}
            className={({ open }) => stylex.props(style(open)).className}
          >
            {children}
          </MenuTrigger>
          <MenuPopup align="end">
            {folders.length === 0 && <p {...stylex.props(menuStyles.empty)}>No folders yet</p>}
            {folders.map((folder) => {
              const inFolder = meeting.folderIds.includes(folder.id);
              return (
                <MenuPrimitive.CheckboxItem
                  key={folder.id}
                  checked={inFolder}
                  onCheckedChange={(checked) => toggle(folder, checked)}
                  className={itemClass}
                >
                  <span {...stylex.props(menuStyles.check)}>
                    <MenuPrimitive.CheckboxItemIndicator>
                      <CheckIcon size={16} />
                    </MenuPrimitive.CheckboxItemIndicator>
                  </span>
                  <span {...stylex.props(menuStyles.label)}>{folder.name}</span>
                </MenuPrimitive.CheckboxItem>
              );
            })}
            <MenuSeparator />
            <MenuItem
              icon={<FolderPlusIcon size={16} />}
              onClick={() => {
                made.current = null;
                setCreating(true);
              }}
            >
              New folder…
            </MenuItem>
          </MenuPopup>
        </Menu>
      )}
      {creating && (
        <FolderDialog
          folder={null}
          open={creating}
          onOpenChange={setCreating}
          save={async (draft) => {
            made.current ??= await hubApi().createFolder(draft);
            await hubApi().setMeetingInFolder(meeting.id, made.current.id, true);
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

const Row = memo(function Row({
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
  onSelect: (id: MeetingId) => void;
  onOpen: (id: MeetingId) => void;
}) {
  const status = statusLabel(meeting);
  const at = meetingAt(meeting);
  const recorded = closedMs(meeting);
  // Clicks in the folder menu and dialog bubble here through their portals, outside the row.
  const open = (event: MouseEvent<HTMLLIElement>) => {
    const { target, currentTarget } = event;
    if (!(target instanceof Element) || !currentTarget.contains(target)) return;
    if (!target.closest("button")) onOpen(meeting.id);
  };
  return (
    <li
      onClick={open}
      onPointerEnter={() => onSelect(meeting.id)}
      onFocus={() => onSelect(meeting.id)}
      {...stylex.props(stylex.defaultMarker(), styles.row, selected && styles.rowSelected)}
    >
      <div {...stylex.props(styles.body)}>
        <button type="button" onClick={() => onOpen(meeting.id)} {...stylex.props(styles.title)}>
          {titleText(meeting)}
        </button>
        <span {...stylex.props(styles.meta)}>
          <time dateTime={new Date(at).toISOString()}>{timeLabel(at)}</time>
          {recorded > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>{durationLabel(recorded)}</span>
            </>
          )}
          {status && <Badge>{status}</Badge>}
          <FolderBadges meeting={meeting} folders={folders} />
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
        style={(menuOpen) => [
          surfaces.control,
          styles.folderButton,
          menuOpen && styles.folderButtonOpen,
        ]}
      >
        <FolderPlusIcon size={14} aria-hidden="true" />
        Add to folder
      </FolderMenu>
    </li>
  );
});

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
    <div {...helpAnchor("meetings.list")} {...stylex.props(styles.days)}>
      {days.map((day) => (
        <section key={day.day} aria-label={day.label} {...stylex.props(styles.day)}>
          <h2 {...stylex.props(styles.dayLabel)}>{day.label}</h2>
          <Card style={styles.card}>
            <ul {...stylex.props(styles.list)}>
              {day.meetings.map((meeting) => (
                <Row
                  key={meeting.id}
                  meeting={meeting}
                  folders={folders}
                  snippet={snippets?.get(meeting.id)}
                  selected={meeting.id === selectedId}
                  onSelect={onSelect}
                  onOpen={onOpen}
                />
              ))}
            </ul>
          </Card>
        </section>
      ))}
    </div>
  );
}

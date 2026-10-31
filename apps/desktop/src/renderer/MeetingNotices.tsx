import * as stylex from "@stylexjs/stylex";

import { titleText, type Meeting, type MeetingBanner, type MeetingId } from "../shared/meetings.ts";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { color, space } from "./tokens.stylex.ts";
import { hubApi } from "./voice.ts";

const styles = stylex.create({
  list: { display: "flex", flexDirection: "column", gap: space.sm },
  notice: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    paddingBlock: 10,
    paddingInline: space.md,
  },
  text: { margin: 0, flexGrow: 1, fontSize: 13.5 },
  title: { fontWeight: 600 },
  muted: { color: color.mutedForeground },
});

/**
 * The notices meetings raised, in the words the notepad and the Flow Bar use. With `onOpen`,
 * each names its meeting and opens it.
 */
export function MeetingNotices({
  notices,
  meetings,
  onOpen,
}: {
  notices: readonly MeetingBanner[];
  meetings?: readonly Meeting[];
  onOpen?: (id: MeetingId) => void;
}) {
  if (notices.length === 0) return null;
  return (
    <div {...stylex.props(styles.list)}>
      {notices.map(({ key, id, text }) => {
        const meeting = onOpen && meetings?.find((candidate) => candidate.id === id);
        return (
          <Card key={key} style={styles.notice}>
            <p role="status" {...stylex.props(styles.text)}>
              {meeting && <span {...stylex.props(styles.title)}>{titleText(meeting)} </span>}
              <span {...stylex.props(meeting && styles.muted)}>{text}</span>
            </p>
            {meeting && onOpen && (
              <Button variant="secondary" onClick={() => onOpen(id)}>
                Open
              </Button>
            )}
            <Button variant="text" onClick={() => void hubApi().dismissMeetingNotice(key)}>
              Dismiss
            </Button>
          </Card>
        );
      })}
    </div>
  );
}

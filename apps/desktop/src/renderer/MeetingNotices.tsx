import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import {
  meetingNoticeActionLabels,
  titleText,
  type Meeting,
  type MeetingBanner,
  type MeetingId,
  type MeetingNoticeAction,
} from "../shared/meetings.ts";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { pageStyles } from "./pageStyles.ts";
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
  onViewSummary,
}: {
  notices: readonly MeetingBanner[];
  meetings?: readonly Meeting[];
  onOpen?: (id: MeetingId) => void;
  onViewSummary: (id: MeetingId) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  if (notices.length === 0) return null;
  const act = (action: MeetingNoticeAction, id: MeetingId) => {
    if (action === "viewSummary") {
      onViewSummary(id);
      return;
    }
    setError(null);
    const command =
      action === "retryFinalPass" ? hubApi().retryMeetingTranscript : hubApi().deleteMeetingAudio;
    command(id).then(
      (result) => setError(result.kind === "refused" ? result.message : null),
      () => setError("Could not do that. Try again."),
    );
  };
  return (
    <div {...stylex.props(styles.list)}>
      {error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {error}
        </p>
      )}
      {notices.map(({ key, id, text, actions, dismissable }) => {
        const meeting = onOpen && meetings?.find((candidate) => candidate.id === id);
        return (
          <Card key={key} style={styles.notice}>
            <p role="status" {...stylex.props(styles.text)}>
              {meeting && <span {...stylex.props(styles.title)}>{titleText(meeting)} </span>}
              <span {...stylex.props(meeting && styles.muted)}>{text}</span>
            </p>
            {actions.map((action) => (
              <Button key={action} variant="secondary" onClick={() => act(action, id)}>
                {meetingNoticeActionLabels[action]}
              </Button>
            ))}
            {meeting && onOpen && actions.length === 0 && (
              <Button variant="secondary" onClick={() => onOpen(id)}>
                Open
              </Button>
            )}
            {dismissable && (
              <Button variant="text" onClick={() => void hubApi().dismissMeetingNotice(key)}>
                Dismiss
              </Button>
            )}
          </Card>
        );
      })}
    </div>
  );
}

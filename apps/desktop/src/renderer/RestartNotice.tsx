import * as stylex from "@stylexjs/stylex";

import type { MeetingBanner } from "../shared/meetings.ts";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { color, leading, space, text } from "./tokens.stylex.ts";
import { hubApi } from "./voice.ts";

const styles = stylex.create({
  notice: {
    gridColumn: "2",
    gridRow: "3",
    display: "flex",
    alignItems: "center",
    gap: space.md,
    marginRight: space.sm,
    marginBottom: space.sm,
    paddingBlock: space.sm,
    paddingLeft: space.base,
    paddingRight: space.sm,
  },
  text: {
    margin: 0,
    flexGrow: 1,
    color: color.foreground,
    fontSize: text.sm,
    lineHeight: leading.sm,
  },
});

export function RestartNotice({ notice }: { notice: MeetingBanner | null }) {
  if (!notice) return null;
  return (
    <Card style={styles.notice}>
      <p role="status" {...stylex.props(styles.text)}>
        {notice.text}
      </p>
      <Button variant="secondary" onClick={() => void hubApi().dismissMeetingNotice(notice.key)}>
        Dismiss
      </Button>
    </Card>
  );
}

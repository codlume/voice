import * as stylex from "@stylexjs/stylex";

import type { MeetingBanner } from "../shared/meetings.ts";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { color, space } from "./tokens.stylex.ts";
import { hubApi } from "./voice.ts";

const styles = stylex.create({
  notice: {
    position: "fixed",
    left: "50%",
    bottom: space.lg,
    transform: "translateX(-50%)",
    display: "flex",
    alignItems: "center",
    gap: space.md,
    width: `min(800px, calc(100vw - 2 * ${space.xl}))`,
    paddingBlock: 10,
    paddingInline: space.md,
  },
  text: { margin: 0, flexGrow: 1, fontSize: 13.5, color: color.foreground },
});

export function RestartNotice({ notice }: { notice: MeetingBanner | null }) {
  if (!notice) return null;
  return (
    <Card style={styles.notice}>
      <p role="status" {...stylex.props(styles.text)}>
        {notice.text}
      </p>
      <Button variant="text" onClick={() => void hubApi().dismissMeetingNotice(notice.key)}>
        Dismiss
      </Button>
    </Card>
  );
}

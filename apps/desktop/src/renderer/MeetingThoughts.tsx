import * as stylex from "@stylexjs/stylex";

import type { Meeting } from "../shared/meetings.ts";
import { Button } from "./Button.tsx";
import { pageStyles } from "./pageStyles.ts";
import { surfaces } from "./surfaces.ts";
import { color, leading, space, text } from "./tokens.stylex.ts";
import { useThoughts } from "./useThoughts.ts";

const styles = stylex.create({
  area: {
    width: "100%",
    color: color.foreground,
    font: "inherit",
    "::placeholder": { color: color.mutedForeground },
  },
  page: {
    minHeight: 280,
    padding: space.base,
    fontSize: text.base,
    lineHeight: leading.base,
    resize: "vertical",
  },
  notepad: {
    flexGrow: 1,
    minHeight: 0,
    padding: space.md,
    borderWidth: 0,
    outlineOffset: -2,
    backgroundColor: "transparent",
    fontSize: text.sm,
    lineHeight: leading.sm,
    resize: "none",
  },
  failure: { display: "flex", alignItems: "center", gap: space.sm },
  failureNotepad: { paddingInline: space.md, paddingBottom: space.sm },
  failureText: { margin: 0, flexGrow: 1 },
});

export function ThoughtsEditor({
  meeting,
  save,
  look,
}: {
  meeting: Meeting;
  save: (notes: string) => Promise<void>;
  look: "page" | "notepad";
}) {
  const thoughts = useThoughts(meeting, save);
  return (
    <>
      <textarea
        aria-label="My thoughts"
        value={thoughts.text}
        placeholder="Write your thoughts here. The summary never changes them."
        onChange={(event) => thoughts.change(event.target.value)}
        {...stylex.props(
          styles.area,
          look === "page" && [surfaces.control, surfaces.field],
          styles[look],
        )}
      />
      {thoughts.error && (
        <div {...stylex.props(styles.failure, look === "notepad" && styles.failureNotepad)}>
          <p role="alert" {...stylex.props(pageStyles.error, styles.failureText)}>
            {thoughts.error}
          </p>
          <Button variant="secondary" disabled={thoughts.pending} onClick={thoughts.retry}>
            Try again
          </Button>
        </div>
      )}
    </>
  );
}

import * as stylex from "@stylexjs/stylex";
import { Fragment } from "react";

import type { Speaker } from "../shared/meetings.ts";
import { inlineRuns, summaryBlocks, type Block } from "./meetingsView.ts";
import { color, leading, radius, space, text as size } from "./tokens.stylex.ts";

const styles = stylex.create({
  // A neutral tint: a name is not a link, so it never takes the primary color.
  name: {
    paddingInline: space.xxs,
    borderRadius: radius.xs,
    backgroundColor: `color-mix(in srgb, ${color.mutedForeground} 15%, transparent)`,
    color: color.foreground,
    fontWeight: 500,
  },
  bold: { fontWeight: 600 },
  summary: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    fontSize: size.base,
    lineHeight: leading.base,
  },
  paragraph: { margin: 0 },
  heading: {
    margin: 0,
    marginTop: space.sm,
    fontSize: size.base,
    fontWeight: 600,
    lineHeight: leading.base,
  },
  list: {
    margin: 0,
    paddingLeft: space.lg,
    display: "flex",
    flexDirection: "column",
    gap: space.xxs,
  },
  nested: { marginTop: space.xxs },
});

export function Inline({ text, speakers }: { text: string; speakers: readonly Speaker[] }) {
  return inlineRuns(text, speakers).map((run) =>
    run.name ? (
      <mark key={run.at} {...stylex.props(styles.name, run.bold && styles.bold)}>
        {run.text}
      </mark>
    ) : run.bold ? (
      <strong key={run.at} {...stylex.props(styles.bold)}>
        {run.text}
      </strong>
    ) : (
      <Fragment key={run.at}>{run.text}</Fragment>
    ),
  );
}

function SummaryBlock({ block, speakers }: { block: Block; speakers: readonly Speaker[] }) {
  if (block.kind === "heading") {
    return (
      <h3 {...stylex.props(styles.heading)}>
        <Inline text={block.text} speakers={speakers} />
      </h3>
    );
  }
  if (block.kind === "paragraph") {
    return (
      <p {...stylex.props(styles.paragraph)}>
        <Inline text={block.text} speakers={speakers} />
      </p>
    );
  }
  return (
    <ul {...stylex.props(styles.list)}>
      {block.items.map((item) => (
        <li key={item.line}>
          <Inline text={item.text} speakers={speakers} />
          {item.children.length > 0 && (
            <ul {...stylex.props(styles.list, styles.nested)}>
              {item.children.map((child) => (
                <li key={child.line}>
                  <Inline text={child.text} speakers={speakers} />
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

export function SummaryMarkdown({
  markdown,
  speakers,
}: {
  markdown: string;
  speakers: readonly Speaker[];
}) {
  return (
    <div {...stylex.props(styles.summary)}>
      {summaryBlocks(markdown).map((block) => (
        <SummaryBlock key={block.line} block={block} speakers={speakers} />
      ))}
    </div>
  );
}

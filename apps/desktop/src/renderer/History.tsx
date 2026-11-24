import * as stylex from "@stylexjs/stylex";
import {
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  FileTextIcon,
  HistoryIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import type { TranscriptVersion } from "../shared/api.ts";
import type { HistoryEntry, HistoryRetention, HistoryState } from "../shared/history.ts";
import type { DayKey } from "../shared/insights.ts";
import { a11y } from "./a11y.ts";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { excerpt, historyPage, timeLabel } from "./historyView.ts";
import { SearchField } from "./Input.tsx";
import { pageStyles } from "./pageStyles.ts";
import { shortcuts, useShortcuts, withShortcut } from "./shortcuts.ts";
import { color, elevation, leading, motion, radius, space, text } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";

const styles = stylex.create({
  section: { display: "flex", flexDirection: "column", gap: space.md },
  head: { display: "flex", alignItems: "center", gap: space.md, minHeight: 32 },
  heading: { display: "flex", alignItems: "baseline", gap: space.sm, flexGrow: 1, minWidth: 0 },
  title: { margin: 0, fontSize: text.sm, fontWeight: 600, lineHeight: leading.sm },
  note: { margin: 0, color: color.mutedForeground, fontSize: text.xs, lineHeight: leading.xs },
  noteFailed: { color: color.errorForeground },
  search: { display: "flex", width: 220, flexShrink: 0 },
  days: { display: "flex", flexDirection: "column", gap: space.lg },
  day: { display: "flex", flexDirection: "column", gap: space.sm },
  // The section label used across the app: small, medium weight, muted, sentence case.
  dayLabel: {
    margin: 0,
    paddingInline: space.xxs,
    color: color.mutedForeground,
    fontSize: text.xs,
    fontWeight: 500,
    lineHeight: leading.xs,
  },
  // Rows tint on hover, so the card clips them to its corners.
  clip: { overflow: "hidden" },
  list: { margin: 0, padding: 0, listStyle: "none" },
  row: {
    position: "relative",
    display: "grid",
    gridTemplateColumns: "56px minmax(0, 1fr)",
    alignItems: "start",
    columnGap: space.md,
    minHeight: 44,
    paddingBlock: 12,
    paddingInline: space.base,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: color.border,
    backgroundColor: { default: "transparent", ":hover": color.accent },
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: { default: motion.fast, [motion.reduced]: "0s" },
  },
  time: {
    paddingTop: 2,
    color: color.mutedForeground,
    fontSize: text.xs,
    lineHeight: leading.xs,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  body: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: space.xs },
  text: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  // Adapted warning badge (MIT, see THIRD_PARTY_NOTICES.md): this transcript never reached its
  // target, so the user may need to copy it.
  notInserted: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.xxs,
    height: 18,
    paddingInline: space.xs,
    borderRadius: radius.xs,
    backgroundColor: color.warningSurface,
    color: color.warningForeground,
    fontSize: text.xs,
    fontWeight: 500,
    lineHeight: leading.xs,
    whiteSpace: "nowrap",
  },
  // Hover and focus reveal a small toolbar over the row's top-right corner, so the text keeps the
  // full row width while the actions are hidden.
  actions: {
    position: "absolute",
    top: 5,
    right: space.sm,
    display: "flex",
    alignItems: "center",
    gap: 2,
    padding: 2,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.medium,
    backgroundColor: color.popover,
    boxShadow: elevation.sm,
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover")]: 1,
      [stylex.when.ancestor(":focus-within")]: 1,
    },
    transitionProperty: "opacity",
    transitionDuration: { default: motion.base, [motion.reduced]: "0s" },
  },
  shown: { opacity: 1 },
  recovery: { display: "flex", alignItems: "center", gap: space.sm },
  copied: {
    display: "flex",
    alignItems: "center",
    gap: space.xxs,
    paddingInline: space.xs,
    color: color.successForeground,
    fontSize: text.xs,
    lineHeight: leading.xs,
  },
  more: { display: "flex", justifyContent: "center" },
});

const ROWS_PER_PAGE = 100;

const storageLabels: Record<HistoryRetention, string> = {
  memory: "Kept in memory until you quit Voice",
  day: "Saved on this Mac for 24 hours",
  month: "Saved on this Mac for 30 days",
  forever: "Saved on this Mac",
};

type Copied = { id: string; version: TranscriptVersion };

const copiedLabels: Record<TranscriptVersion, string> = {
  text: "Copied",
  raw: "Copied raw transcript",
};

const Row = memo(function Row({
  entry,
  copied,
  onCopy,
  onDelete,
}: {
  entry: HistoryEntry;
  copied: TranscriptVersion | null;
  onCopy: (id: string, version: TranscriptVersion) => void;
  onDelete: (id: string) => void;
}) {
  const time = timeLabel(entry.at);
  const named = `from ${time}: ${excerpt(entry.text)}`;
  const copyRow = (event: MouseEvent<HTMLLIElement>) => {
    const clickedButton =
      event.target instanceof Element && event.target.closest("button") !== null;
    const keepSelection = Boolean(window.getSelection()?.toString());
    if (clickedButton || keepSelection) return;
    onCopy(entry.id, "text");
  };
  const missed = entry.status === "notInserted";
  // A missed row confirms its copy on the labelled button the user just pressed.
  const copiedHere = missed && copied === "text";
  return (
    <li onClick={copyRow} {...stylex.props(stylex.defaultMarker(), styles.row)}>
      <time dateTime={new Date(entry.at).toISOString()} {...stylex.props(styles.time)}>
        {time}
      </time>
      <div {...stylex.props(styles.body)}>
        <p {...stylex.props(styles.text)}>{entry.text}</p>
        {missed && (
          // The one transcript the user may need to recover, so its Copy is always in view.
          <div {...stylex.props(styles.recovery)}>
            <span {...stylex.props(styles.notInserted)}>
              <CircleAlertIcon size={12} strokeWidth={2.25} aria-hidden />
              Not inserted
            </span>
            <Button
              variant="secondary"
              aria-label={`Copy dictation ${named}`}
              onClick={() => onCopy(entry.id, "text")}
            >
              {copiedHere ? (
                <CheckIcon size={16} aria-hidden />
              ) : (
                <CopyIcon size={16} aria-hidden />
              )}
              {copiedHere ? "Copied" : "Copy"}
            </Button>
          </div>
        )}
      </div>
      <div {...stylex.props(styles.actions, copied !== null && !copiedHere && styles.shown)}>
        {copied !== null && !copiedHere && (
          <span aria-hidden="true" {...stylex.props(styles.copied)}>
            <CheckIcon size={14} />
            {copiedLabels[copied]}
          </span>
        )}
        {!missed && (
          <Button
            variant="icon"
            aria-label={`Copy dictation ${named}`}
            title="Copy"
            onClick={() => onCopy(entry.id, "text")}
          >
            <CopyIcon size={16} />
          </Button>
        )}
        {entry.raw !== entry.text && (
          <Button
            variant="icon"
            aria-label={`Copy raw transcript ${named}`}
            title="Copy raw transcript"
            onClick={() => onCopy(entry.id, "raw")}
          >
            <FileTextIcon size={16} />
          </Button>
        )}
        <Button
          variant="icon"
          aria-label={`Delete dictation ${named}`}
          title="Delete"
          onClick={() => onDelete(entry.id)}
        >
          <Trash2Icon size={16} />
        </Button>
      </div>
    </li>
  );
});

function Search({ query, onChange }: { query: string; onChange: (query: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  useShortcuts([
    {
      shortcut: shortcuts.searchHistory,
      run: () => {
        input.current?.focus();
        input.current?.select();
      },
    },
  ]);
  return (
    <span {...stylex.props(styles.search)}>
      <SearchField
        ref={input}
        aria-label="Search history"
        autoComplete="off"
        spellCheck={false}
        placeholder={withShortcut("Search", shortcuts.searchHistory)}
        value={query}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          onChange("");
          event.currentTarget.blur();
        }}
      />
    </span>
  );
}

export const History = memo(function History({
  history: { entries, retention, saveFailed },
  today,
}: {
  history: HistoryState;
  today: DayKey;
}) {
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<Copied | null>(null);
  const [rowLimit, setRowLimit] = useState(ROWS_PER_PAGE);
  const copyAction = useAction();
  const deleteAction = useAction();
  if (entries.length === 0 && query !== "") setQuery("");
  const { days, hidden } = useMemo(
    () => historyPage(entries, { query, limit: rowLimit, today }),
    [entries, query, today, rowLimit],
  );

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const { run: runCopy } = copyAction;
  const { run: runDelete } = deleteAction;
  const copy = useCallback(
    (id: string, version: TranscriptVersion) =>
      void runCopy(async () => {
        await hubApi().copyHistoryEntry(id, version);
        setCopied({ id, version });
      }, "Could not copy the transcript."),
    [runCopy],
  );
  const remove = useCallback(
    (id: string) =>
      void runDelete(() => hubApi().deleteHistoryEntry(id), "Could not delete the transcript."),
    [runDelete],
  );

  return (
    <section aria-labelledby="history" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.head)}>
        <div {...stylex.props(styles.heading)}>
          <h2 id="history" {...stylex.props(styles.title)}>
            History
          </h2>
          <p {...stylex.props(styles.note, saveFailed && styles.noteFailed)}>
            {saveFailed
              ? "Could not save on this Mac, so kept until you quit"
              : storageLabels[retention]}
          </p>
        </div>
        {entries.length > 0 && <Search query={query} onChange={setQuery} />}
      </div>
      {entries.length === 0 ? (
        <Card>
          <EmptyState
            icon={<HistoryIcon size={16} />}
            title="No dictations yet"
            description="Your dictations show up here, so you can copy one if it didn't land."
          />
        </Card>
      ) : days.length === 0 ? (
        <Card>
          <EmptyState
            icon={<SearchIcon size={16} />}
            title={`No dictations match “${query.trim()}”`}
            description="Search looks through the text and the raw transcript."
          />
        </Card>
      ) : (
        <div {...stylex.props(styles.days)}>
          {days.map((day) => (
            <div key={day.day} {...stylex.props(styles.day)}>
              <h3 {...stylex.props(styles.dayLabel)}>{day.label}</h3>
              <Card style={styles.clip}>
                <ul {...stylex.props(styles.list)}>
                  {day.entries.map((entry) => (
                    <Row
                      key={entry.id}
                      entry={entry}
                      copied={copied?.id === entry.id ? copied.version : null}
                      onCopy={copy}
                      onDelete={remove}
                    />
                  ))}
                </ul>
              </Card>
            </div>
          ))}
          {hidden > 0 && (
            <div {...stylex.props(styles.more)}>
              <Button
                variant="secondary"
                onClick={() => setRowLimit((limit) => limit + ROWS_PER_PAGE)}
              >
                Show {Math.min(hidden, ROWS_PER_PAGE)} more
              </Button>
            </div>
          )}
        </div>
      )}
      <p role="status" {...stylex.props(a11y.visuallyHidden)}>
        {copied && copiedLabels[copied.version]}
      </p>
      {deleteAction.error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {deleteAction.error}
        </p>
      )}
      {copyAction.error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {copyAction.error}
        </p>
      )}
    </section>
  );
});

import * as stylex from "@stylexjs/stylex";
import { CheckIcon, CopyIcon, FileTextIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import type { TranscriptVersion } from "../shared/api.ts";
import type { HistoryEntry } from "../shared/history.ts";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { historyDays, limitDays, timeLabel } from "./historyView.ts";
import { shortcuts, useShortcuts, withShortcut } from "./shortcuts.ts";
import { color, radius, space } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { useToday } from "./useToday.ts";
import { hubApi } from "./voice.ts";

const reducedMotion = "@media (prefers-reduced-motion: reduce)";

const styles = stylex.create({
  section: { display: "flex", flexDirection: "column", gap: space.sm },
  head: { display: "flex", alignItems: "baseline", justifyContent: "space-between" },
  title: { margin: 0, fontSize: 13, fontWeight: 600 },
  note: { margin: 0, color: color.mutedForeground, fontSize: 12.5 },
  days: { display: "flex", flexDirection: "column", gap: space.lg },
  day: { display: "flex", flexDirection: "column", gap: space.sm },
  dayHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    minHeight: 30,
  },
  dayLabel: {
    margin: 0,
    color: color.mutedForeground,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: "0.075em",
    textTransform: "uppercase",
  },
  search: { position: "relative", display: "flex", alignItems: "center" },
  searchIcon: {
    position: "absolute",
    left: 10,
    color: color.mutedForeground,
    pointerEvents: "none",
  },
  searchInput: {
    width: 220,
    height: 30,
    paddingLeft: 30,
    paddingRight: space.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: color.border, ":focus": color.input },
    borderRadius: radius.medium,
    backgroundColor: color.card,
    color: color.foreground,
    font: "inherit",
    fontSize: 13,
  },
  list: { margin: 0, padding: 0, listStyle: "none" },
  row: {
    display: "grid",
    gridTemplateColumns: "88px minmax(0, 1fr) auto",
    alignItems: "start",
    columnGap: space.md,
    paddingBlock: 14,
    paddingInline: space.lg,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: color.border,
    cursor: "pointer",
  },
  time: {
    paddingTop: 2,
    color: color.mutedForeground,
    fontSize: 13,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  body: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
  text: {
    margin: 0,
    fontSize: 15,
    lineHeight: "20px",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  notInserted: { margin: 0, color: color.errorForeground, fontSize: 12 },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    marginBlock: -4,
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover")]: 1,
      [stylex.when.ancestor(":focus-within")]: 1,
    },
    transitionProperty: "opacity",
    transitionDuration: { default: "150ms", [reducedMotion]: "0s" },
  },
  shown: { opacity: 1 },
  copied: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    paddingInline: 6,
    color: color.successForeground,
    fontSize: 12.5,
  },
  empty: { margin: 0, padding: space.lg, color: color.mutedForeground },
  more: { display: "flex", justifyContent: "center" },
  error: { margin: 0, color: color.errorForeground, fontSize: 12.5 },
  visuallyHidden: {
    position: "absolute",
    width: 1,
    height: 1,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
});

// Rows mount all at once, so a long history shows its newest page and grows on request.
const ROWS_PER_PAGE = 100;

type Copied = { id: string; version: TranscriptVersion };

const copiedLabels: Record<TranscriptVersion, string> = {
  text: "Copied",
  raw: "Copied raw transcript",
};

function Row({
  entry,
  copied,
  onCopy,
  onDelete,
}: {
  entry: HistoryEntry;
  copied: TranscriptVersion | null;
  onCopy: (version: TranscriptVersion) => void;
  onDelete: () => void;
}) {
  const time = timeLabel(entry.at);
  const copyRow = (event: MouseEvent<HTMLLIElement>) => {
    const clickedButton =
      event.target instanceof Element && event.target.closest("button") !== null;
    const keepSelection = Boolean(window.getSelection()?.toString());
    if (clickedButton || keepSelection) return;
    onCopy("text");
  };
  return (
    <li onClick={copyRow} {...stylex.props(stylex.defaultMarker(), styles.row)}>
      <span {...stylex.props(styles.time)}>{time}</span>
      <div {...stylex.props(styles.body)}>
        <p {...stylex.props(styles.text)}>{entry.text}</p>
        {entry.status === "notInserted" && (
          <p {...stylex.props(styles.notInserted)}>Not inserted</p>
        )}
      </div>
      <div {...stylex.props(styles.actions, copied !== null && styles.shown)}>
        {copied !== null && (
          <span aria-hidden="true" {...stylex.props(styles.copied)}>
            <CheckIcon size={14} />
            {copiedLabels[copied]}
          </span>
        )}
        <Button
          variant="icon"
          aria-label={`Copy dictation from ${time}`}
          title="Copy"
          onClick={() => onCopy("text")}
        >
          <CopyIcon size={15} />
        </Button>
        {entry.raw !== entry.text && (
          <Button
            variant="icon"
            aria-label={`Copy raw transcript from ${time}`}
            title="Copy raw transcript"
            onClick={() => onCopy("raw")}
          >
            <FileTextIcon size={15} />
          </Button>
        )}
        <Button
          variant="icon"
          aria-label={`Delete dictation from ${time}`}
          title="Delete"
          onClick={onDelete}
        >
          <Trash2Icon size={15} />
        </Button>
      </div>
    </li>
  );
}

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
    <div {...stylex.props(styles.search)}>
      <SearchIcon size={14} aria-hidden="true" {...stylex.props(styles.searchIcon)} />
      <input
        ref={input}
        type="search"
        aria-label="Search history"
        placeholder={withShortcut("Search", shortcuts.searchHistory)}
        value={query}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          onChange("");
          event.currentTarget.blur();
        }}
        {...stylex.props(styles.searchInput)}
      />
    </div>
  );
}

export function History({
  history: entries,
  storage,
}: {
  history: readonly HistoryEntry[];
  storage: string;
}) {
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<Copied | null>(null);
  const [rowLimit, setRowLimit] = useState(ROWS_PER_PAGE);
  const action = useAction();
  const today = useToday();
  const { days, hidden } = useMemo(
    () => limitDays(historyDays(entries, query, today), rowLimit),
    [entries, query, today, rowLimit],
  );

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = (id: string, version: TranscriptVersion) =>
    void action.run(async () => {
      await hubApi().copyHistoryEntry(id, version);
      setCopied({ id, version });
    }, "Could not copy the transcript.");
  const remove = (id: string) =>
    void action.run(() => hubApi().deleteHistoryEntry(id), "Could not delete the transcript.");

  const [first, ...rest] = days;
  const dayCard = (day: (typeof days)[number]) => (
    <Card>
      <ul {...stylex.props(styles.list)}>
        {day.entries.map((entry) => (
          <Row
            key={entry.id}
            entry={entry}
            copied={copied?.id === entry.id ? copied.version : null}
            onCopy={(version) => copy(entry.id, version)}
            onDelete={() => remove(entry.id)}
          />
        ))}
      </ul>
    </Card>
  );

  return (
    <section aria-labelledby="history" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.head)}>
        <h2 id="history" {...stylex.props(styles.title)}>
          History
        </h2>
        <p {...stylex.props(styles.note)}>{storage}</p>
      </div>
      {entries.length === 0 ? (
        <Card>
          <p {...stylex.props(styles.empty)}>
            Your dictations show up here, so you can copy one if it didn't land.
          </p>
        </Card>
      ) : (
        <div {...stylex.props(styles.days)}>
          <div {...stylex.props(styles.day)}>
            <div {...stylex.props(styles.dayHead)}>
              <h3 {...stylex.props(styles.dayLabel)}>{first?.label ?? "No matches"}</h3>
              <Search query={query} onChange={setQuery} />
            </div>
            {first ? (
              dayCard(first)
            ) : (
              <Card>
                <p {...stylex.props(styles.empty)}>No dictations match “{query.trim()}”.</p>
              </Card>
            )}
          </div>
          {rest.map((day) => (
            <div key={day.day} {...stylex.props(styles.day)}>
              <div {...stylex.props(styles.dayHead)}>
                <h3 {...stylex.props(styles.dayLabel)}>{day.label}</h3>
              </div>
              {dayCard(day)}
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
      <p role="status" {...stylex.props(styles.visuallyHidden)}>
        {copied && copiedLabels[copied.version]}
      </p>
      {action.error && (
        <p role="alert" {...stylex.props(styles.error)}>
          {action.error}
        </p>
      )}
    </section>
  );
}

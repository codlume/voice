import { Tooltip } from "@base-ui/react/tooltip";
import * as stylex from "@stylexjs/stylex";
import { InfoIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";

import type { DayKey } from "../shared/insights.ts";
import { Card } from "./Card.tsx";
import {
  cellLabel,
  DAY_MS,
  insightsView,
  stepDay,
  TYPING_WPM,
  type Heatmap,
  type Level,
} from "./insightsView.ts";
import { color, font, radius, space } from "./tokens.stylex.ts";
import { tooltipPopupClass, tooltipPositionerClass } from "./tooltip.ts";
import { useInsights } from "./useInsights.ts";
import { useToday } from "./useToday.ts";

const CELL = 12;
const GAP = 3;
const MAX_WEEKS = 53;

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.xl },
  headline: {
    margin: 0,
    fontFamily: font.serif,
    fontSize: 36,
    fontWeight: 400,
    lineHeight: 1.15,
    letterSpacing: "-0.01em",
  },
  lede: { margin: 0, marginTop: space.sm, color: color.mutedForeground, fontSize: 15 },
  stats: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: space.md },
  stat: { display: "flex", flexDirection: "column", gap: 6, padding: space.lg },
  label: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    margin: 0,
    fontSize: 13,
    fontWeight: 600,
  },
  value: {
    margin: 0,
    fontFamily: font.serif,
    fontSize: 32,
    fontWeight: 400,
    lineHeight: 1.1,
    fontVariantNumeric: "tabular-nums",
  },
  unit: { fontFamily: font.sans, fontSize: 14, color: color.mutedForeground },
  detail: { margin: 0, color: color.mutedForeground, fontSize: 12.5 },
  fixes: { margin: 0, padding: 0, listStyle: "none" },
  fix: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    color: color.mutedForeground,
    fontSize: 12.5,
  },
  fixCount: { marginInlineStart: "auto", fontVariantNumeric: "tabular-nums" },
  info: {
    display: "grid",
    placeItems: "center",
    width: 16,
    height: 16,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.round,
    backgroundColor: "transparent",
    color: { default: color.mutedForeground, ":hover": color.foreground },
    cursor: "default",
    outline: { default: "none", ":focus-visible": `2px solid ${color["--ring"]}` },
  },
  wrap: { maxWidth: 260, whiteSpace: "normal" },
  streaks: { display: "flex", gap: space.xl },
  heatmap: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    columnGap: space.sm,
    rowGap: 4,
    marginTop: space.md,
  },
  months: {
    display: "grid",
    gridAutoColumns: CELL,
    columnGap: GAP,
    height: 14,
    color: color.mutedForeground,
    fontSize: 11,
  },
  month: (column: number) => ({
    gridColumnStart: column + 1,
    gridRowStart: 1,
    whiteSpace: "nowrap",
  }),
  weekdays: {
    display: "grid",
    gridTemplateRows: `repeat(7, ${CELL}px)`,
    rowGap: GAP,
    color: color.mutedForeground,
    fontSize: 10,
    lineHeight: `${CELL}px`,
  },
  grid: {
    display: "grid",
    gridTemplateRows: `repeat(7, ${CELL}px)`,
    gridAutoFlow: "column",
    gridAutoColumns: CELL,
    gap: GAP,
  },
  cell: {
    borderRadius: 3,
    outline: { default: "none", ":focus-visible": `2px solid ${color["--ring"]}` },
    outlineOffset: 1,
  },
  legend: {
    gridColumnStart: 2,
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: GAP,
    marginTop: 4,
    color: color.mutedForeground,
    fontSize: 11,
  },
  legendCell: { width: CELL, height: CELL },
  legendLabel: { marginInline: 4 },
});

const shades = stylex.create({
  none: { backgroundColor: color.border },
  low: { backgroundColor: `color-mix(in srgb, ${color.primary} 30%, ${color.card})` },
  medium: { backgroundColor: `color-mix(in srgb, ${color.primary} 55%, ${color.card})` },
  high: { backgroundColor: `color-mix(in srgb, ${color.primary} 78%, ${color.card})` },
  top: { backgroundColor: color.primary },
});
const levels = [shades.none, shades.low, shades.medium, shades.high, shades.top] as const;

function useWeeksThatFit(): [(element: HTMLElement | null) => void, number | null] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [weeks, setWeeks] = useState<number | null>(null);
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const fit = Math.floor((entry.contentRect.width + GAP) / (CELL + GAP));
      setWeeks(Math.min(MAX_WEEKS, Math.max(1, fit)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, weeks];
}

function Info({ label, children }: { label: string; children: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={<button type="button" />}
        aria-label={`About ${label}`}
        {...stylex.props(styles.info)}
      >
        <InfoIcon size={13} aria-hidden="true" />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="top" sideOffset={6} className={tooltipPositionerClass()}>
          <Tooltip.Popup className={tooltipPopupClass(styles.wrap)}>{children}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function Stat({
  label,
  info,
  children,
}: {
  label: string;
  info?: string | undefined;
  children: ReactNode;
}) {
  return (
    <Card style={styles.stat}>
      <h2 {...stylex.props(styles.label)}>
        {label}
        {info && <Info label={label}>{info}</Info>}
      </h2>
      {children}
    </Card>
  );
}

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" });
const A_SUNDAY = Date.UTC(2026, 0, 4);
const weekdayLabels = Array.from({ length: 7 }, (_, row) => ({
  row,
  label: row % 2 === 1 ? weekday.format(A_SUNDAY + row * DAY_MS) : "",
}));

const HeatmapGrid = memo(function HeatmapGrid({ heatmap }: { heatmap: Heatmap }) {
  const [focused, setFocused] = useState<DayKey | null>(null);
  const cells = heatmap.weeks.flat().filter((cell) => cell !== null);
  const tabStop = cells.some((cell) => cell.day === focused) ? focused : cells.at(-1)?.day;
  return (
    <Tooltip.Provider delay={150} closeDelay={0}>
      <Tooltip.Root<string>>
        {({ payload }) => (
          <>
            <div role="group" aria-label="Words per day" {...stylex.props(styles.grid)}>
              {cells.map((cell) => (
                <Tooltip.Trigger
                  key={cell.day}
                  payload={cellLabel(cell)}
                  render={<span role="img" aria-label={cellLabel(cell)} />}
                  tabIndex={cell.day === tabStop ? 0 : -1}
                  data-day={cell.day}
                  onFocus={() => setFocused(cell.day)}
                  onKeyDown={(event) => {
                    const to = stepDay(heatmap, cell.day, event.key);
                    if (to === null) return;
                    event.preventDefault();
                    event.currentTarget.parentElement
                      ?.querySelector<HTMLElement>(`[data-day="${to}"]`)
                      ?.focus();
                  }}
                  {...stylex.props(styles.cell, levels[cell.level])}
                />
              ))}
            </div>
            <Tooltip.Portal>
              <Tooltip.Positioner side="top" sideOffset={6} className={tooltipPositionerClass()}>
                <Tooltip.Popup className={tooltipPopupClass()}>{payload}</Tooltip.Popup>
              </Tooltip.Positioner>
            </Tooltip.Portal>
          </>
        )}
      </Tooltip.Root>
    </Tooltip.Provider>
  );
});

function Activity({
  heatmap,
  fit,
}: {
  heatmap: Heatmap | null;
  fit: (element: HTMLElement | null) => void;
}) {
  return (
    <div {...stylex.props(styles.heatmap)}>
      <span />
      <div aria-hidden="true" {...stylex.props(styles.months)}>
        {heatmap?.months.map(({ column, label }) => (
          <span key={column} {...stylex.props(styles.month(column))}>
            {label}
          </span>
        ))}
      </div>
      <div aria-hidden="true" {...stylex.props(styles.weekdays)}>
        {weekdayLabels.map(({ row, label }) => (
          <span key={row}>{label}</span>
        ))}
      </div>
      <div ref={fit}>{heatmap && <HeatmapGrid heatmap={heatmap} />}</div>
      <div aria-hidden="true" {...stylex.props(styles.legend)}>
        <span {...stylex.props(styles.legendLabel)}>Less</span>
        {([0, 1, 2, 3, 4] as const satisfies readonly Level[]).map((level) => (
          <span key={level} {...stylex.props(styles.legendCell, styles.cell, levels[level])} />
        ))}
        <span {...stylex.props(styles.legendLabel)}>More</span>
      </div>
    </div>
  );
}

export const Insights = memo(function Insights() {
  const insights = useInsights();
  const today = useToday();
  const [fit, weeks] = useWeeksThatFit();
  const view = useMemo(
    () => insights && insightsView(insights, today, weeks ?? 1),
    [insights, today, weeks],
  );

  return (
    <div {...stylex.props(styles.page)}>
      <header>
        <h1 {...stylex.props(styles.headline)}>Insights</h1>
        <p {...stylex.props(styles.lede)}>
          Counted on this Mac from your dictations. Voice keeps the numbers, never your words.
        </p>
      </header>
      {view && (
        <>
          <div {...stylex.props(styles.stats)}>
            <Stat
              label="Pace"
              info={
                view.pace
                  ? `Your pace over your last ${count(view.pace.sessions, "dictation", "dictations")}, not counting the quiet before and after you speak. The average typist does ${Math.round(TYPING_WPM)} WPM.`
                  : undefined
              }
            >
              {view.pace ? (
                <>
                  <p {...stylex.props(styles.value)}>
                    {view.pace.wpm} <span {...stylex.props(styles.unit)}>WPM</span>
                  </p>
                  {view.pace.fasterThanTyping !== null && (
                    <p {...stylex.props(styles.detail)}>
                      {view.pace.fasterThanTyping.toFixed(1)}× faster than typing
                    </p>
                  )}
                </>
              ) : (
                <p {...stylex.props(styles.detail)}>Dictate to see how fast you speak.</p>
              )}
            </Stat>
            <Stat label="Words">
              <p {...stylex.props(styles.value)}>{view.totalWords.toLocaleString()}</p>
              <p {...stylex.props(styles.detail)}>words dictated</p>
            </Stat>
            <Stat label="Fixes made by Voice">
              <p {...stylex.props(styles.value)}>{view.fixes.total.toLocaleString()}</p>
              {view.fixes.total === 0 ? (
                <p {...stylex.props(styles.detail)}>None yet</p>
              ) : (
                <ul {...stylex.props(styles.fixes)}>
                  {view.fixes.corrected > 0 && (
                    <li {...stylex.props(styles.fix)}>
                      Words corrected
                      <Info label="words corrected">
                        Filler words like "um," false starts, and other words cleanup corrected
                      </Info>
                      <span {...stylex.props(styles.fixCount)}>
                        {view.fixes.corrected.toLocaleString()}
                      </span>
                    </li>
                  )}
                  {view.fixes.dictionaryFixes > 0 && (
                    <li {...stylex.props(styles.fix)}>
                      Dictionary fixes
                      <Info label="dictionary fixes">Corrections from your dictionary</Info>
                      <span {...stylex.props(styles.fixCount)}>
                        {view.fixes.dictionaryFixes.toLocaleString()}
                      </span>
                    </li>
                  )}
                </ul>
              )}
            </Stat>
          </div>
          <Stat label="Streak">
            <div {...stylex.props(styles.streaks)}>
              <p {...stylex.props(styles.value)}>
                {view.streak.current}{" "}
                <span {...stylex.props(styles.unit)}>
                  {view.streak.current === 1 ? "day" : "days"} current
                </span>
              </p>
              <p {...stylex.props(styles.value)}>
                {view.streak.longest}{" "}
                <span {...stylex.props(styles.unit)}>
                  {view.streak.longest === 1 ? "day" : "days"} longest
                </span>
              </p>
            </div>
            <Activity heatmap={weeks === null ? null : view.heatmap} fit={fit} />
          </Stat>
        </>
      )}
    </div>
  );
});

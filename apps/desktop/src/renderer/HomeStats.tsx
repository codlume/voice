import * as stylex from "@stylexjs/stylex";
import { useMemo, type ReactNode } from "react";

import type { DayKey } from "../shared/insights.ts";
import type { Assignment } from "../shared/style.ts";
import { a11y } from "./a11y.ts";
import { AppIcon } from "./AppIcon.tsx";
import { Card } from "./Card.tsx";
import { insightsView, usage, type InsightsView, type UsageView } from "./insightsView.ts";
import { appNames } from "./styleView.ts";
import { color, font, layout, space } from "./tokens.stylex.ts";
import { useInsights } from "./useInsights.ts";
import { useInstalledApps } from "./useInstalledApps.ts";

const styles = stylex.create({
  aside: {
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
    position: {
      default: "sticky",
      [layout.narrow]: "static",
      // Pinned with both cards, the aside needs a window about 575px tall to show whole.
      "@media (max-height: 600px)": "static",
    },
    top: 0,
    flexShrink: 0,
    width: { default: 250, [layout.narrow]: "auto" },
    order: { default: 0, [layout.narrow]: -1 },
  },
  link: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    padding: 0,
    borderWidth: 0,
    borderRadius: "inherit",
    backgroundColor: { default: "transparent", ":hover": color.accent },
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
  },
  foot: {
    paddingBlock: space.md,
    paddingInline: space.lg,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: color.border,
    color: color.mutedForeground,
    fontSize: 12.5,
  },
  statList: {
    display: "flex",
    flexDirection: { default: "column", [layout.narrow]: "row" },
    flexWrap: "wrap",
    gap: { default: space.md, [layout.narrow]: space.xl },
    padding: space.lg,
  },
  stat: { display: "flex", alignItems: "baseline", gap: space.sm },
  statValue: {
    fontFamily: font.serif,
    fontSize: 28,
    fontWeight: 400,
    lineHeight: 1.1,
    letterSpacing: "-0.02em",
    fontVariantNumeric: "tabular-nums",
  },
  statLabel: { color: color.mutedForeground, fontSize: 14 },
  topApps: { display: "flex", flexDirection: "column", gap: space.md, padding: space.lg },
  label: { margin: 0, fontSize: 13, fontWeight: 600 },
  appList: {
    display: "flex",
    flexDirection: { default: "column", [layout.narrow]: "row" },
    flexWrap: { default: "nowrap", [layout.narrow]: "wrap" },
    gap: { default: space.sm, [layout.narrow]: space.lg },
  },
  app: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    minWidth: 0,
    maxWidth: "100%",
    fontSize: 13,
    fontVariantNumeric: "tabular-nums",
  },
  appName: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  appShare: { color: color.mutedForeground },
});

function InsightsLink({
  onOpen,
  foot,
  children,
}: {
  onOpen: () => void;
  foot: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <button type="button" onClick={onOpen} {...stylex.props(styles.link)}>
        <span {...stylex.props(a11y.visuallyHidden)}>Open Insights.</span>
        {children}
        {foot && <span {...stylex.props(styles.foot)}>{foot}</span>}
      </button>
    </Card>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <span {...stylex.props(styles.stat)}>
      <span {...stylex.props(styles.statValue)}>{value}</span>
      <span {...stylex.props(styles.statLabel)}>{label}</span>
    </span>
  );
}

function Stats({ view, onOpen }: { view: InsightsView | null; onOpen: () => void }) {
  return (
    <InsightsLink
      onOpen={onOpen}
      foot={
        view?.pace?.fasterThanTyping &&
        `${view.pace.fasterThanTyping.toFixed(1)}× faster than typing`
      }
    >
      <span {...stylex.props(styles.statList)}>
        <Stat value={view ? view.totalWords.toLocaleString() : "–"} label="words" />
        <Stat value={view?.pace ? String(view.pace.wpm) : "–"} label="WPM" />
        <Stat value={view ? String(view.streak.current) : "–"} label="day streak" />
      </span>
    </InsightsLink>
  );
}

function TopApps({ where, onOpen }: { where: UsageView; onOpen: () => void }) {
  return (
    <InsightsLink
      onOpen={onOpen}
      foot={where.appsUsed > where.topApps.length && `${where.appsUsed} apps used`}
    >
      <span {...stylex.props(styles.topApps)}>
        <span {...stylex.props(styles.label)}>Top apps</span>
        <span {...stylex.props(styles.appList)}>
          {where.topApps.map(({ bundleId, name, share }) => (
            <span key={bundleId} {...stylex.props(styles.app)}>
              <AppIcon bundleId={bundleId} name={name} size={20} decorative />
              <span title={name} {...stylex.props(styles.appName)}>
                {name}
              </span>
              <span {...stylex.props(styles.appShare)}>{share}%</span>
            </span>
          ))}
        </span>
      </span>
    </InsightsLink>
  );
}

export function YourStats({
  today,
  assignments,
  onOpenInsights,
}: {
  today: DayKey;
  assignments: readonly Assignment[];
  onOpenInsights: () => void;
}) {
  const insights = useInsights();
  const installed = useInstalledApps();
  const view = useMemo(() => insights && insightsView(insights, today, 1), [insights, today]);
  const where = useMemo(
    () => insights && usage(insights, appNames(assignments, installed)),
    [insights, assignments, installed],
  );
  return (
    <aside aria-label="Your stats" {...stylex.props(styles.aside)}>
      <Stats view={view} onOpen={onOpenInsights} />
      {where && where.topApps.length > 0 && <TopApps where={where} onOpen={onOpenInsights} />}
    </aside>
  );
}

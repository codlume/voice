import type { InstalledApp } from "../shared/api.ts";
import {
  BUILT_IN_APPS,
  parseBundleId,
  parseHost,
  type BundleId,
  type Category,
  type Host,
} from "../shared/app-categories.ts";
import { assignedCategory, assignmentKey, type Assignment } from "../shared/style.ts";

const BANNER_ICONS = 4;

export const CATEGORY_LABELS: Record<Category, string> = {
  personal: "Personal messages",
  work: "Work messages",
  email: "Email",
  other: "Other",
};

export const VOICE_BUNDLE_ID = parseBundleId("com.voice.app");

export type BannerApp = { bundleId: BundleId; name: string };

export type Banner = { shown: BannerApp[]; overflow: string[] };

export type Chip = { key: string; assignment: Assignment; bundleId: BundleId | null; name: string };

export type PickerRow = { bundleId: BundleId; name: string; current: Category | null };

const catalogNames = new Map<BundleId, string>(
  BUILT_IN_APPS.map(({ bundleId, name }) => [bundleId, name]),
);

export function appNames(
  assignments: readonly Assignment[],
  installed: readonly InstalledApp[],
): (bundleId: BundleId) => string {
  const assigned = new Map(
    assignments.flatMap((a) => (a.kind === "app" ? [[a.bundleId, a.name] as const] : [])),
  );
  const installedNames = new Map(installed.map(({ bundleId, name }) => [bundleId, name]));
  return (bundleId) =>
    assigned.get(bundleId) ??
    catalogNames.get(bundleId) ??
    installedNames.get(bundleId) ??
    bundleId;
}

export function bannerApps(
  category: Category,
  installed: readonly InstalledApp[],
  assignments: readonly Assignment[],
): Banner {
  const installedIds = new Set(installed.map((app) => app.bundleId));
  const moved = new Set(assignments.flatMap((a) => (a.kind === "app" ? [a.bundleId] : [])));
  const byName = new Map<string, BannerApp>();
  for (const { bundleId, name, category: of } of BUILT_IN_APPS) {
    if (
      of === category &&
      installedIds.has(bundleId) &&
      !moved.has(bundleId) &&
      !byName.has(name)
    ) {
      byName.set(name, { bundleId, name });
    }
  }
  const apps = [...byName.values()];
  return {
    shown: apps.slice(0, BANNER_ICONS),
    overflow: apps.slice(BANNER_ICONS).map(({ name }) => name),
  };
}

export function chips(category: Category, assignments: readonly Assignment[]): Chip[] {
  return assignments.flatMap((assignment): Chip[] => {
    if (assignment.category !== category) return [];
    return assignment.kind === "app"
      ? [
          {
            key: assignmentKey(assignment),
            assignment,
            bundleId: assignment.bundleId,
            name: assignment.name,
          },
        ]
      : [{ key: assignmentKey(assignment), assignment, bundleId: null, name: assignment.host }];
  });
}

const assignable = ({ browser, bundleId }: InstalledApp) =>
  !browser && bundleId !== VOICE_BUNDLE_ID;

const searchRank = (name: string, query: string): number | null => {
  const lower = name.toLocaleLowerCase();
  if (lower.startsWith(query)) return 0;
  if (lower.split(/[\s.-]+/).some((word) => word.startsWith(query))) return 1;
  return lower.includes(query) ? 2 : null;
};

export function pickerRows(
  category: Category,
  installed: readonly InstalledApp[],
  assignments: readonly Assignment[],
  query: string,
): PickerRow[] {
  const q = query.trim().toLocaleLowerCase();
  const nameOf = appNames([], installed);
  return installed
    .filter(assignable)
    .flatMap(({ bundleId }) => {
      const name = nameOf(bundleId);
      const rank = searchRank(name, q);
      if (rank === null) return [];
      const current = assignedCategory({ bundleId, host: null }, assignments);
      return [{ row: { bundleId, name, current }, rank }];
    })
    .toSorted((a, b) => a.rank - b.rank || a.row.name.localeCompare(b.row.name))
    .map(({ row }) => row);
}

export const rowHint = ({ current }: PickerRow, category: Category): string | null =>
  current !== null && current !== category ? `In ${CATEGORY_LABELS[current]}` : null;

export type SiteInput =
  | { kind: "empty" }
  | { kind: "invalid"; message: string }
  | { kind: "add"; host: Host; message: string };

export function siteInput(
  input: string,
  category: Category,
  assignments: readonly Assignment[],
): SiteInput {
  if (input.trim() === "") return { kind: "empty" };
  const host = parseHost(input);
  if (host === null) return { kind: "invalid", message: "Enter a website like slack.com" };
  const now = assignedCategory({ bundleId: null, host }, assignments);
  const message =
    now === category
      ? `${host} is already in ${CATEGORY_LABELS[category]}`
      : now === null
        ? `Adds ${host}`
        : `Moves ${host} here from ${CATEGORY_LABELS[now]}`;
  return { kind: "add", host, message };
}

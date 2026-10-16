import type { CleanupStyle, WritingStyle } from "@voice/cleanup/style";

import {
  APP_CATEGORIES,
  CATEGORIES,
  SITE_CATEGORIES,
  parseBundleId,
  parseHost,
  type BundleId,
  type Category,
  type Host,
} from "./app-categories.ts";

export type Assignment =
  | { kind: "app"; bundleId: BundleId; name: string; category: Category }
  | { kind: "site"; host: Host; category: Category };

export type CategoryStyles = Readonly<Record<Category, WritingStyle>>;

export const DEFAULT_STYLES: CategoryStyles = {
  personal: "casual",
  work: "formal",
  email: "formal",
  other: "formal",
};

/** Where one session's text goes. Never stored, logged, or sent. */
export type Target = { bundleId: BundleId; host: Host | null };

function parseAssignment(item: unknown): Assignment | null {
  if (typeof item !== "object" || item === null || !("kind" in item) || !("category" in item)) {
    return null;
  }
  const category = CATEGORIES.find((value) => value === item.category);
  if (category === undefined) return null;
  if (item.kind === "app" && "bundleId" in item && "name" in item) {
    const { bundleId, name } = item;
    if (typeof bundleId !== "string" || typeof name !== "string") return null;
    const key = parseBundleId(bundleId);
    const label = name.trim();
    return key === null || label === ""
      ? null
      : { kind: "app", bundleId: key, name: label, category };
  }
  if (item.kind === "site" && "host" in item && typeof item.host === "string") {
    const key = parseHost(item.host);
    return key === null ? null : { kind: "site", host: key, category };
  }
  return null;
}

export const assignmentKey = (assignment: Assignment): string =>
  assignment.kind === "app" ? `app:${assignment.bundleId}` : `site:${assignment.host}`;

export function parseAssignments(raw: unknown): Assignment[] {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, Assignment>();
  for (const item of raw) {
    const assignment = parseAssignment(item);
    if (assignment === null) continue;
    const key = assignmentKey(assignment);
    byKey.delete(key);
    byKey.set(key, assignment);
  }
  return [...byKey.values()];
}

function categoryBySuffix(
  host: string | null,
  sites: ReadonlyMap<string, Category>,
): Category | undefined {
  if (host === null) return undefined;
  const dot = host.indexOf(".");
  return sites.get(host) ?? (dot === -1 ? undefined : categoryBySuffix(host.slice(dot + 1), sites));
}

type Lookup = { bundleId: BundleId | null; host: Host | null };

export function assignedCategory(
  { bundleId, host }: Lookup,
  assignments: readonly Assignment[],
): Category | null {
  const userSites = new Map<string, Category>();
  const userApps = new Map<string, Category>();
  for (const assignment of assignments) {
    if (assignment.kind === "site") userSites.set(assignment.host, assignment.category);
    else userApps.set(assignment.bundleId, assignment.category);
  }
  const app = (apps: ReadonlyMap<string, Category>) =>
    bundleId === null ? undefined : apps.get(bundleId);
  return (
    categoryBySuffix(host, userSites) ??
    app(userApps) ??
    categoryBySuffix(host, SITE_CATEGORIES) ??
    app(APP_CATEGORIES) ??
    null
  );
}

export const classify = (target: Target | null, assignments: readonly Assignment[]): Category =>
  target === null ? "other" : (assignedCategory(target, assignments) ?? "other");

const lookupOf = (assignment: Assignment): Lookup =>
  assignment.kind === "app"
    ? { bundleId: assignment.bundleId, host: null }
    : { bundleId: null, host: assignment.host };

export function place(
  assignments: readonly Assignment[],
  assignment: Assignment,
): readonly Assignment[] {
  const lookup = lookupOf(assignment);
  if (assignedCategory(lookup, assignments) === assignment.category) return assignments;
  const key = assignmentKey(assignment);
  const rest = assignments.filter((existing) => assignmentKey(existing) !== key);
  return assignedCategory(lookup, rest) === assignment.category ? rest : [...rest, assignment];
}

export const unassign = (
  assignments: readonly Assignment[],
  assignment: Assignment,
): readonly Assignment[] =>
  assignments.filter((existing) => assignmentKey(existing) !== assignmentKey(assignment));

/** One change to the assignments, applied by main to whatever list is current when it runs. */
export type AssignmentEdit =
  | { op: "place"; assignment: Assignment }
  | { op: "unassign"; assignment: Assignment };

export const applyAssignmentEdit = (
  assignments: readonly Assignment[],
  edit: AssignmentEdit,
): readonly Assignment[] =>
  edit.op === "place"
    ? place(assignments, edit.assignment)
    : unassign(assignments, edit.assignment);

export function parseAssignmentEdit(raw: unknown): AssignmentEdit | null {
  if (typeof raw !== "object" || raw === null || !("op" in raw) || !("assignment" in raw)) {
    return null;
  }
  const [assignment] = parseAssignments([raw.assignment]);
  if (assignment === undefined) return null;
  return raw.op === "place" || raw.op === "unassign" ? { op: raw.op, assignment } : null;
}

export const cleanupStyleFor = (category: Category, styles: CategoryStyles): CleanupStyle => ({
  style: styles[category],
  layout: category === "email" ? "email" : "general",
});

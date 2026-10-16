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

export function parseAssignments(raw: unknown): Assignment[] {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, Assignment>();
  for (const item of raw) {
    const assignment = parseAssignment(item);
    if (assignment === null) continue;
    const key =
      assignment.kind === "app" ? `app:${assignment.bundleId}` : `site:${assignment.host}`;
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

export function classify(target: Target | null, assignments: readonly Assignment[]): Category {
  if (target === null) return "other";
  const { bundleId, host } = target;
  const userSites = new Map<string, Category>();
  const userApps = new Map<string, Category>();
  for (const assignment of assignments) {
    if (assignment.kind === "site") userSites.set(assignment.host, assignment.category);
    else userApps.set(assignment.bundleId, assignment.category);
  }
  return (
    categoryBySuffix(host, userSites) ??
    userApps.get(bundleId) ??
    categoryBySuffix(host, SITE_CATEGORIES) ??
    APP_CATEGORIES.get(bundleId) ??
    "other"
  );
}

export const cleanupStyleFor = (category: Category, styles: CategoryStyles): CleanupStyle => ({
  style: styles[category],
  layout: category === "email" ? "email" : "general",
});

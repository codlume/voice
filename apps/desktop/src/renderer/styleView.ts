import type { InstalledApp } from "../shared/api.ts";
import { BUILT_IN_APPS, type BundleId, type Category } from "../shared/app-categories.ts";

export const BANNER_ICONS = 4;

export type BannerApp = { bundleId: BundleId; name: string };

export type Banner = { shown: BannerApp[]; overflow: string[] };

/** The installed catalog apps of a category in catalog order. An app shipped under two ids, like classic and new Teams, appears once. */
export function bannerApps(category: Category, installed: readonly InstalledApp[]): Banner {
  const installedIds = new Set(installed.map((app) => app.bundleId));
  const byName = new Map<string, BannerApp>();
  for (const { bundleId, name, category: of } of BUILT_IN_APPS) {
    if (of === category && installedIds.has(bundleId) && !byName.has(name)) {
      byName.set(name, { bundleId, name });
    }
  }
  const apps = [...byName.values()];
  return {
    shown: apps.slice(0, BANNER_ICONS),
    overflow: apps.slice(BANNER_ICONS).map(({ name }) => name),
  };
}

import type { InstalledApp } from "../shared/api.ts";
import { BUILT_IN_APPS, type BundleId, type Category } from "../shared/app-categories.ts";

export const BANNER_ICONS = 4;

export type BannerApp = { bundleId: BundleId; name: string; icon: string | null; letter: string };

export type Banner = { shown: BannerApp[]; overflow: string[] };

export function bannerApps(category: Category, installed: readonly InstalledApp[]): Banner {
  const icons = new Map<BundleId, string | null>(installed.map((app) => [app.bundleId, app.icon]));
  const apps = BUILT_IN_APPS.flatMap(({ bundleId, name, category: of }): BannerApp[] => {
    const icon = icons.get(bundleId);
    if (of !== category || icon === undefined) return [];
    return [{ bundleId, name, icon, letter: name.slice(0, 1).toUpperCase() }];
  });
  return {
    shown: apps.slice(0, BANNER_ICONS),
    overflow: apps.slice(BANNER_ICONS).map(({ name }) => name),
  };
}

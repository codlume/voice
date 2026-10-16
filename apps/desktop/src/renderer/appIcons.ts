import type { AppIcons, InstalledApp } from "../shared/api.ts";
import type { BundleId } from "../shared/app-categories.ts";
import { hubApi } from "./voice.ts";

export type IconLoader = {
  /** The icon in memory, fresh or stale. */
  get(bundleId: BundleId): string | null;
  /** Fetches the icon unless a fresh one is in memory. Requests made in the same tick travel as one fetch. Resolves null when it could not be rendered and forgets the id, so a later call asks again. */
  load(bundleId: BundleId): Promise<string | null>;
  /** Marks every icon in memory stale. A stale icon stays on show until a load replaces it. */
  invalidate(): void;
  /** Calls the listener after an invalidation and after a fetch changed an icon. */
  subscribe(listener: () => void): () => void;
};

export function createIconLoader(fetch: (bundleIds: BundleId[]) => Promise<AppIcons>): IconLoader {
  const icons = new Map<BundleId, { icon: string; generation: number }>();
  const inFlight = new Map<BundleId, Promise<string | null>>();
  const listeners = new Set<() => void>();
  let generation = 0;
  let batch: { ids: Set<BundleId>; result: Promise<AppIcons> } | null = null;

  function notify() {
    for (const listener of listeners) listener();
  }

  function enqueue(bundleId: BundleId): Promise<AppIcons> {
    if (batch === null) {
      const ids = new Set<BundleId>();
      batch = {
        ids,
        result: Promise.resolve().then(() => {
          batch = null;
          return fetch([...ids]);
        }),
      };
    }
    batch.ids.add(bundleId);
    return batch.result;
  }

  return {
    get: (bundleId) => icons.get(bundleId)?.icon ?? null,
    load(bundleId) {
      const memo = icons.get(bundleId);
      if (memo !== undefined && memo.generation === generation) return Promise.resolve(memo.icon);
      let pending = inFlight.get(bundleId);
      if (pending === undefined) {
        const requested = generation;
        pending = enqueue(bundleId)
          .then(
            (result) => {
              const icon = result[bundleId];
              const changed = icon !== icons.get(bundleId)?.icon;
              if (icon !== undefined) icons.set(bundleId, { icon, generation: requested });
              else icons.delete(bundleId);
              if (changed) notify();
              return icon ?? null;
            },
            () => null,
          )
          .finally(() => inFlight.delete(bundleId));
        inFlight.set(bundleId, pending);
      }
      return pending;
    },
    invalidate() {
      generation += 1;
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const iconLoader = createIconLoader((bundleIds) => hubApi().getAppIcons(bundleIds));

export async function listInstalledApps(): Promise<InstalledApp[]> {
  const apps = await hubApi().getInstalledApps();
  iconLoader.invalidate();
  return apps;
}

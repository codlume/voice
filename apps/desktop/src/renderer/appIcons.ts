import type { AppIcons } from "../shared/api.ts";
import type { BundleId } from "../shared/app-categories.ts";

export type IconLoader = {
  get(bundleId: BundleId): string | null;
  /** Fetches the icon. Requests made in the same tick travel as one fetch. Resolves null when it could not be rendered and forgets the id, so a later call asks again. */
  load(bundleId: BundleId): Promise<string | null>;
};

export function createIconLoader(fetch: (bundleIds: BundleId[]) => Promise<AppIcons>): IconLoader {
  const icons = new Map<BundleId, string>();
  const inFlight = new Map<BundleId, Promise<string | null>>();
  let batch: { ids: Set<BundleId>; result: Promise<AppIcons> } | null = null;

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
    get: (bundleId) => icons.get(bundleId) ?? null,
    load(bundleId) {
      const cached = icons.get(bundleId);
      if (cached !== undefined) return Promise.resolve(cached);
      let pending = inFlight.get(bundleId);
      if (pending === undefined) {
        pending = enqueue(bundleId)
          .then(
            (result) => {
              const icon = result[bundleId];
              if (icon !== undefined) icons.set(bundleId, icon);
              return icon ?? null;
            },
            () => null,
          )
          .finally(() => inFlight.delete(bundleId));
        inFlight.set(bundleId, pending);
      }
      return pending;
    },
  };
}

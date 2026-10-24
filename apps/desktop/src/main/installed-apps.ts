import { parseBundleId, type BundleId } from "../shared/app-categories.ts";
import type { AppIcons, InstalledApp } from "../shared/api.ts";
import type { HelperCommand, HelperEvent } from "./protocol.ts";

type Listed = Extract<HelperEvent, { type: "apps.listed" }>["apps"];
type Rendered = Extract<HelperEvent, { type: "icons.rendered" }>["icons"];

export type InstalledApps = {
  list(): Promise<InstalledApp[]>;
  /** Icons of apps from the latest list; callers need not list first. Leaves out any the helper could not render. */
  icons(bundleIds: readonly BundleId[]): Promise<AppIcons>;
  onHelperEvent(event: HelperEvent): void;
  /** Settles every reply still awaited, since the exited helper will not send them. */
  helperExited(): void;
};

export const ICONS_PER_HELPER_LINE = 32;

export function createInstalledApps(options: {
  /** False when no helper is running to receive the command, so no reply will come. */
  send: (command: HelperCommand) => boolean;
}): InstalledApps {
  const { send } = options;
  const iconsByPath = new Map<string, { modifiedMs: number; icon: string }>();
  let latest: { pathsById: Map<BundleId, string>; stamps: Map<string, number> } | null = null;
  let onListed: ((apps: Listed | null) => void) | null = null;
  const onRendered = new Map<string, (icons: Rendered | null) => void>();
  let renderId = 0;
  let inFlight: Promise<InstalledApp[]> | null = null;

  // The scan can take seconds on the first launch of a new build, so there is no deadline. Null
  // means no reply can come: the helper was not running to receive the command, or exited first.
  function reply<T>(wait: (resolve: (value: T | null) => void) => void, command: HelperCommand) {
    return new Promise<T | null>((resolve) => {
      wait(resolve);
      if (!send(command)) resolve(null);
    });
  }

  async function load(): Promise<InstalledApp[]> {
    try {
      const listed = await reply<Listed>((resolve) => (onListed = resolve), {
        type: "apps.list",
      });
      if (listed === null) throw new Error("The helper did not list installed apps.");
      const apps = new Map<BundleId, { name: string; path: string; browser: boolean }>();
      for (const { bundleId: raw, name, path, browser } of listed) {
        const bundleId = parseBundleId(raw);
        if (bundleId !== null && !apps.has(bundleId)) apps.set(bundleId, { name, path, browser });
      }
      const stamps = new Map(listed.map(({ path, modifiedMs }) => [path, modifiedMs]));
      for (const [path, { modifiedMs }] of iconsByPath) {
        if (stamps.get(path) !== modifiedMs) iconsByPath.delete(path);
      }
      latest = { pathsById: new Map([...apps].map(([id, { path }]) => [id, path])), stamps };
      return [...apps].map(([bundleId, { name, browser }]) => ({ bundleId, name, browser }));
    } finally {
      onListed = null;
    }
  }

  async function render(paths: string[], stamps: ReadonlyMap<string, number>): Promise<void> {
    const id = String(++renderId);
    try {
      const icons = await reply<Rendered>((resolve) => onRendered.set(id, resolve), {
        type: "icons.render",
        id,
        paths,
      });
      for (const { path, png } of icons ?? []) {
        const modifiedMs = stamps.get(path);
        if (modifiedMs !== undefined) {
          iconsByPath.set(path, { modifiedMs, icon: `data:image/png;base64,${png}` });
        }
      }
    } finally {
      onRendered.delete(id);
    }
  }

  function list() {
    inFlight ??= load().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    list,
    async icons(bundleIds) {
      if (latest === null) await list().catch(() => null);
      if (latest === null) return {};
      const { pathsById, stamps } = latest;
      const paths = new Map<BundleId, string>();
      for (const bundleId of bundleIds) {
        const path = pathsById.get(bundleId);
        if (path !== undefined) paths.set(bundleId, path);
      }
      const missing = [...new Set(paths.values())].filter((path) => !iconsByPath.has(path));
      const batches: string[][] = [];
      for (let i = 0; i < missing.length; i += ICONS_PER_HELPER_LINE) {
        batches.push(missing.slice(i, i + ICONS_PER_HELPER_LINE));
      }
      await Promise.all(batches.map((batch) => render(batch, stamps)));
      const icons: AppIcons = {};
      for (const [bundleId, path] of paths) {
        const icon = iconsByPath.get(path)?.icon;
        if (icon !== undefined) icons[bundleId] = icon;
      }
      return icons;
    },
    onHelperEvent(event) {
      switch (event.type) {
        case "apps.listed":
          onListed?.(event.apps);
          return;
        case "icons.rendered":
          onRendered.get(event.id)?.(event.icons);
          return;
      }
    },
    helperExited() {
      onListed?.(null);
      for (const resolve of onRendered.values()) resolve(null);
    },
  };
}

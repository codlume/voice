import { APP_CATEGORIES, parseBundleId, type BundleId } from "../shared/app-categories.ts";
import type { InstalledApp } from "../shared/api.ts";
import type { HelperCommand, HelperEvent } from "./protocol.ts";

type Listed = Extract<HelperEvent, { type: "apps.listed" }>["apps"];

export type InstalledApps = {
  list(): Promise<InstalledApp[]>;
  onHelperEvent(event: HelperEvent): void;
};

export function createInstalledApps(options: {
  send: (command: HelperCommand) => void;
  timeoutMs?: number;
}): InstalledApps {
  const { send, timeoutMs = 5000 } = options;
  const iconsByPath = new Map<string, string>();
  let onListed: ((apps: Listed) => void) | null = null;
  let onRendered: (() => void) | null = null;
  let inFlight: Promise<InstalledApp[]> | null = null;

  function replyBeforeDeadline<T>(
    wait: (resolve: (value: T) => void) => void,
    command: HelperCommand,
  ) {
    return new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      wait((value) => {
        clearTimeout(timer);
        resolve(value);
      });
      send(command);
    });
  }

  async function load(): Promise<InstalledApp[]> {
    try {
      const listed = await replyBeforeDeadline<Listed>((resolve) => (onListed = resolve), {
        type: "apps.list",
      });
      if (listed === null) throw new Error("The helper did not list installed apps in time.");
      const apps = new Map<BundleId, { name: string; path: string }>();
      for (const { bundleId: raw, name, path } of listed) {
        const bundleId = parseBundleId(raw);
        if (bundleId !== null && !apps.has(bundleId)) apps.set(bundleId, { name, path });
      }
      const paths = [...apps]
        .filter(([bundleId, { path }]) => APP_CATEGORIES.has(bundleId) && !iconsByPath.has(path))
        .map(([, { path }]) => path);
      if (paths.length > 0) {
        await replyBeforeDeadline<void>((resolve) => (onRendered = resolve), {
          type: "icons.render",
          paths,
        });
      }
      return [...apps].map(([bundleId, { name, path }]) => ({
        bundleId,
        name,
        icon: iconsByPath.get(path) ?? null,
      }));
    } finally {
      onListed = null;
      onRendered = null;
    }
  }

  return {
    list() {
      inFlight ??= load().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    onHelperEvent(event) {
      switch (event.type) {
        case "apps.listed":
          onListed?.(event.apps);
          return;
        case "icons.rendered":
          for (const { path, png } of event.icons)
            iconsByPath.set(path, `data:image/png;base64,${png}`);
          onRendered?.();
          return;
      }
    },
  };
}

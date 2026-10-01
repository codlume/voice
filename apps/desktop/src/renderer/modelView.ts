import type { ModelStatus } from "../shared/api.ts";
import type { Model } from "../shared/models.ts";

export type ModelAction = "Install" | "Retry" | "Uninstall";

type ModelView = {
  text: string;
  actions: readonly { label: ModelAction; disabled: boolean }[];
};

export function modelView(
  model: Model,
  status: ModelStatus,
  { cleanupEnabled, dictating }: { cleanupEnabled: boolean; dictating: boolean },
): ModelView {
  const install = { label: "Install", disabled: false } as const;
  const retry = { label: "Retry", disabled: false } as const;
  const uninstall = {
    label: "Uninstall",
    disabled: model.neededWhileDictating && dictating,
  } as const;
  switch (status.state) {
    case "missing":
      return { text: "Not installed", actions: [install] };
    case "downloading":
      return {
        text:
          status.progress === undefined
            ? "Downloading"
            : `Downloading ${Math.round(status.progress * 100)}%`,
        actions: [],
      };
    case "loading":
      return { text: "Loading", actions: [] };
    case "ready":
      return { text: "Installed", actions: [uninstall] };
    case "installed":
      return {
        text: cleanupEnabled
          ? "Installed. Loads when you dictate in English."
          : "Installed. Loads when text cleanup is on.",
        actions: [uninstall],
      };
    case "failed":
      return { text: status.message, actions: [retry, uninstall] };
  }
}

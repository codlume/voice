import type { ModelStatus } from "../shared/api.ts";

export type ModelAction = "Install" | "Retry" | "Uninstall";

export function modelView(
  status: ModelStatus,
  cleanupEnabled: boolean,
): { text: string; actions: readonly ModelAction[] } {
  switch (status.state) {
    case "missing":
      return { text: "Not installed", actions: ["Install"] };
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
      return { text: "Installed", actions: ["Uninstall"] };
    case "installed":
      return {
        text: cleanupEnabled
          ? "Installed. Loads when you dictate in English."
          : "Installed. Loads when text cleanup is on.",
        actions: ["Uninstall"],
      };
    case "failed":
      return { text: status.message, actions: ["Retry", "Uninstall"] };
  }
}

import type { ModelStatus, PillState } from "../shared/api.ts";
import type { BusyDuring, Model } from "../shared/models.ts";

export const PREPARING_TEXT = "Preparing for this Mac, about 30 s";

export type ModelAction = "Install" | "Retry" | "Uninstall" | "Cancel";

export type Activity = BusyDuring | "idle";

type ModelView = {
  text: string;
  actions: readonly { label: ModelAction; disabled: boolean }[];
};

export function activityOf(session: PillState): Activity {
  switch (session.kind) {
    case "listening":
    case "processing":
      return "dictation";
    case "transforming":
      return "transform";
    case "idle":
    case "done":
    case "transformDone":
      return "idle";
  }
}

export function modelView(
  model: Model,
  status: ModelStatus,
  { cleanupEnabled, activity }: { cleanupEnabled: boolean; activity: Activity },
): ModelView {
  const install = { label: "Install", disabled: false } as const;
  const retry = { label: "Retry", disabled: false } as const;
  const cancel = { label: "Cancel", disabled: false } as const;
  const uninstall = { label: "Uninstall", disabled: model.busyDuring === activity } as const;
  switch (status.state) {
    case "missing":
      return { text: "Not installed", actions: [install] };
    case "downloading":
      return {
        text:
          status.progress === undefined
            ? "Downloading"
            : `Downloading ${Math.round(status.progress * 100)}%`,
        actions: model.cancelableDownload ? [cancel] : [],
      };
    case "loading":
      return { text: status.preparing ? PREPARING_TEXT : "Loading", actions: [] };
    case "ready":
      return { text: "Installed", actions: [uninstall] };
    case "installed":
      return { text: installedText(model, cleanupEnabled), actions: [uninstall] };
    case "failed":
      return { text: status.message, actions: [retry, uninstall] };
  }
}

function installedText(model: Model, cleanupEnabled: boolean): string {
  switch (model.id) {
    case "transform":
      return "Installed. Loads when you run a transform.";
    case "asr":
    case "cleanup":
      return cleanupEnabled
        ? "Installed. Loads when you dictate in English."
        : "Installed. Loads when text cleanup is on.";
  }
}

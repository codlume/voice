import type { PendingUpdate, PillState, UpdateStatus } from "../shared/api.ts";

export function updateStatusText(status: UpdateStatus): string {
  switch (status.kind) {
    case "disabled":
      return status.reason;
    case "idle":
      return "Updates are checked automatically";
    case "checking":
      return "Checking for updates…";
    case "current":
      return "Voice is up to date";
    case "downloading":
      return `Downloading ${status.version} · ${Math.round(status.percent)}%`;
    case "ready":
      return `Version ${status.version} is ready to install`;
    case "installing":
      return `Installing ${status.version}…`;
    case "failed":
      return status.message;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export function releaseCardTitle(update: PendingUpdate): string {
  return update.kind === "ready"
    ? "Update ready to install"
    : `Downloading update · ${Math.round(update.percent)}%`;
}

export type UpdateButton = { action: "check" | "restart" | null; label: string; tooltip: string };

export function updateButton(status: UpdateStatus, session: PillState): UpdateButton {
  switch (status.kind) {
    case "idle":
    case "current":
      return button("check", "Check for updates");
    case "failed":
      return { action: "check", label: "Check for updates", tooltip: status.message };
    case "ready":
      return session.kind === "listening" || session.kind === "processing"
        ? button(null, "Finish dictation before restarting")
        : button("restart", `Restart to install ${status.version}`);
    case "checking":
    case "downloading":
    case "installing":
    case "disabled":
      return button(null, updateStatusText(status));
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function button(action: UpdateButton["action"], label: string): UpdateButton {
  return { action, label, tooltip: label };
}

import {
  pendingUpdate,
  type PendingUpdate,
  type PillState,
  type UpdateStatus,
} from "../shared/api.ts";

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
    case "available":
      return `Version ${status.version} is available`;
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
  switch (update.kind) {
    case "available":
      return `Download ${update.version}`;
    case "ready":
      return `Restart to install ${update.version}`;
    case "downloading":
      return updateStatusText(update);
    default: {
      const exhaustive: never = update;
      return exhaustive;
    }
  }
}

export type UpdateCard =
  | { kind: "release"; update: PendingUpdate }
  | { kind: "error"; message: string };

export function updateCard(status: UpdateStatus, actionError: string | null): UpdateCard | null {
  if (actionError !== null) return { kind: "error", message: actionError };
  if (status.kind === "failed") return { kind: "error", message: status.message };
  const update = pendingUpdate(status);
  return update && { kind: "release", update };
}

export type UpdateButton = { action: "check" | "download" | "restart" | null; label: string };

export function updateButton(status: UpdateStatus, session: PillState): UpdateButton {
  switch (status.kind) {
    case "idle":
    case "current":
    case "failed":
      return button("check", "Check for updates");
    case "available":
      return button("download", releaseCardTitle(status));
    case "ready":
      return session.kind === "listening" || session.kind === "processing"
        ? button(null, "Finish dictation before restarting")
        : button("restart", releaseCardTitle(status));
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
  return { action, label };
}

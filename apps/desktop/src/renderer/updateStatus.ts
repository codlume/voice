import type { PillState, UpdateStatus } from "../shared/api.ts";

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

export type UpdateButton = { action: "check" | "restart" | null; label: string };

export function updateButton(status: UpdateStatus, session: PillState): UpdateButton {
  switch (status.kind) {
    case "idle":
    case "current":
      return { action: "check", label: "Check for updates" };
    case "failed":
      return { action: "check", label: status.message };
    case "ready":
      return session.kind === "listening" || session.kind === "processing"
        ? { action: null, label: "Finish dictation before restarting" }
        : { action: "restart", label: `Restart to install ${status.version}` };
    default:
      return { action: null, label: updateStatusText(status) };
  }
}

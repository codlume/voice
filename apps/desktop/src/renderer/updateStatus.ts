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

export function canRestartForUpdate(status: UpdateStatus, session: PillState): boolean {
  return status.kind === "ready" && session.kind !== "listening" && session.kind !== "processing";
}

import {
  pendingUpdate,
  type PendingUpdate,
  type PillState,
  type RestartChoice,
  type UpdateStatus,
} from "../shared/api.ts";
import { atRiskOnQuit, historySurvivesQuit, type HistoryState } from "../shared/history.ts";

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

export function updateCard(status: UpdateStatus, actionError: string): UpdateCard | null {
  if (actionError) return { kind: "error", message: actionError };
  if (status.kind === "failed") return { kind: "error", message: status.message };
  const update = pendingUpdate(status);
  return update && { kind: "release", update };
}

type UpdateButton = { action: "check" | "download" | "restart" | null; label: string };

export function updateButton(status: UpdateStatus, session: PillState): UpdateButton {
  switch (status.kind) {
    case "idle":
    case "current":
    case "failed":
      return { action: "check", label: "Check for updates" };
    case "available":
      return { action: "download", label: releaseCardTitle(status) };
    case "ready":
      return session.kind === "listening" || session.kind === "processing"
        ? { action: null, label: "Finish dictation before restarting" }
        : { action: "restart", label: releaseCardTitle(status) };
    case "checking":
    case "downloading":
    case "installing":
    case "disabled":
      return { action: null, label: updateStatusText(status) };
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export type RestartPrompt = {
  description: string;
  actions: readonly { label: string; choice: RestartChoice }[];
};

const restartAction = { label: "Restart", choice: "restart" } as const;
const copyAndRestartAction = {
  label: "Copy transcript and restart",
  choice: "copyTranscriptAndRestart",
} as const;

export function restartPrompt(history: HistoryState): RestartPrompt {
  const { retention, saveFailed } = history;
  if (history.entries.length === 0) {
    return {
      description: "Voice will close and reopen with the downloaded version.",
      actions: [restartAction],
    };
  }
  if (historySurvivesQuit(retention, saveFailed)) {
    return {
      description:
        "Voice will close and reopen with the downloaded version. Your history is saved on this Mac, so your transcripts will still be there.",
      actions: [restartAction],
    };
  }
  // A transcript that never reached its target exists nowhere else, so restarting must save it.
  const needsRecovery = atRiskOnQuit(history) !== null;
  const kept =
    retention === "memory"
      ? "Your history is kept only until Voice closes."
      : "Your history could not be saved on this Mac.";
  return {
    description: `${kept} Copy your last transcript to the clipboard before restarting. This replaces the current clipboard contents.`,
    actions: needsRecovery ? [copyAndRestartAction] : [restartAction, copyAndRestartAction],
  };
}

/**
 * Whether a prompt opened on `opened` still says and offers the same for `current`. Status is not
 * compared: it only moves from pending to settled, and main checks it again before restarting.
 */
export const samePrompt = (opened: HistoryState, current: HistoryState) =>
  opened.entries[0]?.id === current.entries[0]?.id &&
  opened.retention === current.retention &&
  opened.saveFailed === current.saveFailed;

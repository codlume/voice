import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import type { PillState, UpdatesSnapshot } from "../shared/api.ts";
import { canRestartForUpdate, updateStatusText } from "./updateStatus.ts";
import { color, radius, space } from "./tokens.stylex.ts";

const styles = stylex.create({
  sidebar: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: space.sm },
  sidebarLine: { display: "flex", alignItems: "center", gap: space.sm },
  status: { margin: 0, color: color.mutedForeground, fontSize: 12, textAlign: "right" },
  failed: { color: color.errorForeground },
  iconButton: {
    flexShrink: 0,
    display: "grid",
    placeItems: "center",
    width: 28,
    height: 28,
    padding: 0,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.small,
    backgroundColor: { default: "transparent", ":hover": color.accent },
    color: color.foreground,
    cursor: { default: "pointer", ":disabled": "default" },
  },
  action: {
    paddingBlock: 5,
    paddingInline: 9,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.small,
    backgroundColor: { default: color.card, ":hover": color.accent },
    color: color.foreground,
    font: "inherit",
    fontSize: 12,
    cursor: { default: "pointer", ":disabled": "default" },
  },
  error: { margin: 0, color: color.errorForeground, fontSize: 12, textAlign: "right" },
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The update action failed. Try again.";
}

export function SidebarUpdates({
  updates,
  session,
}: {
  updates: UpdatesSnapshot;
  session: PillState;
}) {
  const [actionError, setActionError] = useState("");
  const status = updates.status;
  const canCheck =
    status.kind !== "disabled" &&
    status.kind !== "checking" &&
    status.kind !== "downloading" &&
    status.kind !== "ready" &&
    status.kind !== "installing";
  const canRestart = canRestartForUpdate(status, session);
  const restartBlocked = status.kind === "ready" && !canRestart;

  async function run(action: () => Promise<void>) {
    setActionError("");
    try {
      await action();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  return (
    <div {...stylex.props(styles.sidebar)}>
      <div {...stylex.props(styles.sidebarLine)}>
        <p
          role="status"
          aria-live="polite"
          {...stylex.props(styles.status, status.kind === "failed" && styles.failed)}
        >
          {updateStatusText(status)}
        </p>
        <button
          type="button"
          aria-label="Check for updates"
          title={status.kind === "disabled" ? status.reason : "Check for updates"}
          disabled={!canCheck}
          onClick={() => void run(() => window.voice.checkForUpdates())}
          {...stylex.props(styles.iconButton)}
        >
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M16.5 9A6.5 6.5 0 1 0 16 12.5" />
            <path d="M16.5 4.5V9H12" />
          </svg>
        </button>
      </div>
      {status.kind === "ready" && (
        <button
          type="button"
          disabled={!canRestart}
          title={
            restartBlocked ? "Finish dictation before restarting" : "Restart to install update"
          }
          onClick={() => void run(() => window.voice.restartForUpdate())}
          {...stylex.props(styles.action)}
        >
          Restart to update
        </button>
      )}
      {actionError && (
        <p role="alert" {...stylex.props(styles.error)}>
          {actionError}
        </p>
      )}
    </div>
  );
}

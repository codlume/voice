import * as stylex from "@stylexjs/stylex";
import { CircleAlertIcon, DownloadIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { type PillState, type UpdateStatus, type UpdatesSnapshot } from "../shared/api.ts";
import type { HistoryState } from "../shared/history.ts";
import { a11y } from "./a11y.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { UpdateCardTrigger } from "./UpdateCard.tsx";
import {
  restartPrompt,
  samePrompt,
  updateButton,
  updateCard,
  updateStatusText,
} from "./updateStatus.ts";
import { useAction } from "./useAction.ts";
import { color } from "./tokens.stylex.ts";
import { hubApi } from "./voice.ts";

const enabledHover = ":hover:not([aria-disabled=true])";

// The row shows only while there is something to act on: an update to get, or one that failed.
const styles = stylex.create({
  row: {
    backgroundColor: { default: color.accent, [enabledHover]: color.sidebarRowHover },
    color: { default: color.foreground, [enabledHover]: color.foreground },
  },
  icon: { flexShrink: 0, color: color.primary },
  failedIcon: { color: color.errorForeground },
  label: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
  unavailable: { cursor: "not-allowed" },
});

function StatusIcon({ status, failed }: { status: UpdateStatus; failed: boolean }) {
  const Icon = failed
    ? CircleAlertIcon
    : status.kind === "ready" || status.kind === "installing"
      ? RotateCwIcon
      : DownloadIcon;
  return <Icon size={16} {...stylex.props(styles.icon, failed && styles.failedIcon)} />;
}

type RestartConfirm = { open: boolean; history: HistoryState };

export function SidebarUpdates({
  updates,
  session,
  history,
  rowStyle,
}: {
  updates: UpdatesSnapshot;
  session: PillState;
  history: HistoryState;
  /** The sidebar's row look, which the update row shares. */
  rowStyle: stylex.StyleXStyles;
}) {
  const { error: actionError, run: runAction } = useAction();
  const [confirm, setConfirm] = useState<RestartConfirm | null>(null);
  const status = updates.status;
  const { action, label } = updateButton(status, session);
  const card = updateCard(status, actionError);
  const shown = card !== null || status.kind === "installing";
  if (confirm?.open && (action !== "restart" || !samePrompt(confirm.history, history)))
    setConfirm({ ...confirm, open: false });
  const prompt = confirm && restartPrompt(confirm.history);

  const confirmRestart = () => setConfirm({ open: true, history });
  const onRestartRequest = useEffectEvent(() => {
    if (action === "restart") confirmRestart();
  });
  useEffect(() => hubApi().onRestartRequest(() => onRestartRequest()), []);

  const run = (task: () => Promise<void>) =>
    runAction(task, "The update action failed. Try again.");

  return (
    <>
      <p role="status" aria-live="polite" {...stylex.props(a11y.visuallyHidden)}>
        {actionError || updateStatusText(status)}
      </p>
      {shown && (
        <UpdateCardTrigger
          card={card}
          label={label}
          disabled={action === null}
          onClick={() => {
            if (action === "restart") confirmRestart();
            else if (action === "download") void run(() => hubApi().downloadUpdate());
            else void run(() => hubApi().checkForUpdates());
          }}
          style={[rowStyle, styles.row, action === null && styles.unavailable]}
        >
          <StatusIcon status={status} failed={card?.kind === "error"} />
          <span {...stylex.props(styles.label)}>{label}</span>
        </UpdateCardTrigger>
      )}
      {confirm && prompt && (
        <ConfirmDialog
          open={confirm.open}
          onOpenChange={(open) => setConfirm({ ...confirm, open })}
          title="Restart Voice to install the update?"
          description={prompt.description}
          actions={prompt.actions.map((option) => ({
            label: option.label,
            variant: "primary",
            onClick: () =>
              void run(() =>
                hubApi().restartForUpdate({
                  choice: option.choice,
                  latest: confirm.history.entries[0]?.id ?? null,
                }),
              ),
          }))}
        />
      )}
    </>
  );
}

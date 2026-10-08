import * as stylex from "@stylexjs/stylex";
import { CheckIcon, DownloadIcon, RefreshCwIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import {
  pendingUpdate,
  sameTranscript,
  type PillState,
  type Snapshot,
  type UpdateStatus,
  type UpdatesSnapshot,
} from "../shared/api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { UpdateCardTrigger } from "./UpdateCard.tsx";
import {
  restartPrompt,
  updateButton,
  updateCard,
  updateStatusText,
  type RestartPrompt,
} from "./updateStatus.ts";
import { useAction } from "./useAction.ts";
import { color, radius } from "./tokens.stylex.ts";

const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

const reducedMotion = "@media (prefers-reduced-motion: reduce)";
const enabledHover = ":hover:not([aria-disabled=true])";
const buttonSize = 32;
const ringRadius = 14;
const ringCircumference = 2 * Math.PI * ringRadius;

const styles = stylex.create({
  button: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    width: buttonSize,
    height: buttonSize,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.round,
    backgroundColor: { default: "transparent", [enabledHover]: color.sidebarRowHover },
    color: { default: color.mutedForeground, [enabledHover]: color.foreground },
    cursor: "pointer",
    transitionProperty: "background-color, color",
    transitionDuration: "150ms",
  },
  hasUpdate: {
    backgroundColor: {
      default: color.sidebarRowSelected,
      [enabledHover]: color.sidebarRowHover,
    },
    color: color.foreground,
  },
  unavailable: { cursor: "not-allowed" },
  failed: { color: color.errorForeground },
  dimmed: { opacity: 0.6 },
  spinner: { display: "grid" },
  spinning: {
    animationName: { default: spin, [reducedMotion]: "none" },
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  ring: { position: "absolute", inset: 0, transform: "rotate(-90deg)", pointerEvents: "none" },
  ringTrack: { opacity: 0.22 },
  ringProgress: {
    transitionProperty: "stroke-dashoffset",
    transitionDuration: { default: "300ms", [reducedMotion]: "0s" },
    transitionTimingFunction: "ease-out",
  },
  badge: {
    position: "absolute",
    right: 5,
    bottom: 5,
    display: "grid",
    placeItems: "center",
    width: 10,
    height: 10,
    borderRadius: radius.round,
    backgroundColor: color.foreground,
    color: color.background,
    boxShadow: `0 0 0 2px ${color.card}`,
  },
  visuallyHidden: {
    position: "absolute",
    width: 1,
    height: 1,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
});

function RefreshGlyph({ checking }: { checking: boolean }) {
  const [spinning, setSpinning] = useState(checking);
  if (checking && !spinning) setSpinning(true);
  const stopAtEndOfTurn = () => {
    if (!checking) setSpinning(false);
  };

  return (
    <span
      onAnimationIteration={stopAtEndOfTurn}
      {...stylex.props(styles.spinner, spinning && styles.spinning)}
    >
      <RefreshCwIcon size={16} />
    </span>
  );
}

function StatusIcon({ status }: { status: UpdateStatus }) {
  if (status.kind === "available") {
    return (
      <>
        <DownloadIcon size={16} />
        <span {...stylex.props(styles.badge)} />
      </>
    );
  }

  if (status.kind === "downloading") {
    const offset = ringCircumference * (1 - status.percent / 100);
    return (
      <>
        <svg aria-hidden="true" viewBox="0 0 32 32" {...stylex.props(styles.ring)}>
          <circle
            cx="16"
            cy="16"
            r={ringRadius}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            {...stylex.props(styles.ringTrack)}
          />
          <circle
            cx="16"
            cy="16"
            r={ringRadius}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray={ringCircumference}
            strokeDashoffset={offset}
            {...stylex.props(styles.ringProgress)}
          />
        </svg>
        <DownloadIcon size={16} />
      </>
    );
  }

  if (status.kind === "ready" || status.kind === "installing") {
    return (
      <>
        <RotateCwIcon size={16} />
        <span {...stylex.props(styles.badge)}>
          <CheckIcon size={8} strokeWidth={4} />
        </span>
      </>
    );
  }

  return <RefreshGlyph checking={status.kind === "checking"} />;
}

export function SidebarUpdates({
  updates,
  session,
  last,
}: {
  updates: UpdatesSnapshot;
  session: PillState;
  last: Snapshot["last"];
}) {
  const { error: actionError, run: runAction } = useAction();
  // The prompt is fixed when it opens, so its choices match the transcript the user saw.
  const [confirm, setConfirm] = useState<{
    open: boolean;
    last: Snapshot["last"];
    prompt: RestartPrompt;
  } | null>(null);
  const status = updates.status;
  const { action, label } = updateButton(status, session);
  const card = updateCard(status, actionError);

  // Dictation, a channel switch, or a newer transcript can withdraw the restart the dialog offered.
  if (confirm?.open && (action !== "restart" || !sameTranscript(confirm.last, last)))
    setConfirm({ ...confirm, open: false });

  const confirmRestart = () =>
    setConfirm({ open: true, last, prompt: restartPrompt(last, session) });
  const onRestartRequest = useEffectEvent(() => {
    if (action === "restart") confirmRestart();
  });
  useEffect(() => window.voice.onRestartRequest(() => onRestartRequest()), []);

  const run = (task: () => Promise<void>) =>
    runAction(task, "The update action failed. Try again.");

  return (
    <>
      <p role="status" aria-live="polite" {...stylex.props(styles.visuallyHidden)}>
        {actionError || updateStatusText(status)}
      </p>
      <UpdateCardTrigger
        card={card}
        label={label}
        disabled={action === null}
        onClick={() => {
          if (action === "restart") confirmRestart();
          else if (action === "download") void run(() => window.voice.downloadUpdate());
          else void run(() => window.voice.checkForUpdates());
        }}
        style={[
          styles.button,
          (pendingUpdate(status) !== null || status.kind === "installing") && styles.hasUpdate,
          card?.kind === "error" && styles.failed,
          status.kind === "disabled" && styles.dimmed,
          action === null && styles.unavailable,
        ]}
      >
        <StatusIcon status={status} />
      </UpdateCardTrigger>
      {confirm && (
        <ConfirmDialog
          open={confirm.open}
          onOpenChange={(open) => setConfirm({ ...confirm, open })}
          title="Restart Voice to install the update?"
          description={confirm.prompt.description}
          actions={confirm.prompt.actions.map((option) => ({
            label: option.label,
            variant: "primary",
            onClick: () =>
              void run(() =>
                window.voice.restartForUpdate({ choice: option.choice, last: confirm.last }),
              ),
          }))}
        />
      )}
    </>
  );
}

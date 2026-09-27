import * as stylex from "@stylexjs/stylex";
import { useState, type ReactNode } from "react";

import type { PillState, UpdateStatus, UpdatesSnapshot } from "../shared/api.ts";
import { updateButton, updateStatusText } from "./updateStatus.ts";
import { color, radius } from "./tokens.stylex.ts";

const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

const reducedMotion = "@media (prefers-reduced-motion: reduce)";
const buttonSize = 32;
const ringRadius = 14;
const ringCircumference = 2 * Math.PI * ringRadius;

const styles = stylex.create({
  sidebar: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 },
  button: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    width: buttonSize,
    height: buttonSize,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.round,
    backgroundColor: { default: "transparent", ":hover:not(:disabled)": color.sidebarRowHover },
    color: { default: color.mutedForeground, ":hover:not(:disabled)": color.foreground },
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    transitionProperty: "background-color, color",
    transitionDuration: "150ms",
  },
  pending: {
    backgroundColor: {
      default: color.sidebarRowSelected,
      ":hover:not(:disabled)": color.sidebarRowHover,
    },
    color: color.foreground,
  },
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
  error: { margin: 0, color: color.errorForeground, fontSize: 12, textAlign: "right" },
});

function Glyph({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

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
      <Glyph>
        <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
        <path d="M8 16H3v5" />
      </Glyph>
    </span>
  );
}

function StatusIcon({ status }: { status: UpdateStatus }) {
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
        <Glyph>
          <path d="M12 15V3" />
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="m7 10 5 5 5-5" />
        </Glyph>
      </>
    );
  }

  if (status.kind === "ready" || status.kind === "installing") {
    return (
      <>
        <Glyph>
          <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
        </Glyph>
        <span {...stylex.props(styles.badge)}>
          <Glyph size={8}>
            <path d="M20 6 9 17l-5-5" strokeWidth="4" />
          </Glyph>
        </span>
      </>
    );
  }

  return <RefreshGlyph checking={status.kind === "checking"} />;
}

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
  const { action, label, tooltip } = updateButton(status, session);

  async function run(task: () => Promise<void>) {
    setActionError("");
    try {
      await task();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  return (
    <div {...stylex.props(styles.sidebar)}>
      <p role="status" aria-live="polite" {...stylex.props(styles.visuallyHidden)}>
        {updateStatusText(status)}
      </p>
      <button
        type="button"
        aria-label={label}
        title={tooltip}
        disabled={action === null}
        onClick={() =>
          void run(() =>
            action === "restart" ? window.voice.restartForUpdate() : window.voice.checkForUpdates(),
          )
        }
        {...stylex.props(
          styles.button,
          (status.kind === "ready" ||
            status.kind === "installing" ||
            status.kind === "downloading") &&
            styles.pending,
          status.kind === "failed" && styles.failed,
          status.kind === "disabled" && styles.dimmed,
        )}
      >
        <StatusIcon status={status} />
      </button>
      {actionError && (
        <p role="alert" {...stylex.props(styles.error)}>
          {actionError}
        </p>
      )}
    </div>
  );
}

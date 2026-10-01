import { Popover } from "@base-ui/react/popover";
import * as stylex from "@stylexjs/stylex";
import { useRef, useState, type ReactNode } from "react";

import {
  pendingUpdate,
  type PendingUpdate,
  type PillState,
  type UpdateStatus,
  type UpdatesSnapshot,
} from "../shared/api.ts";
import { releaseCardTitle, updateButton, updateStatusText } from "./updateStatus.ts";
import { color, font, radius, space } from "./tokens.stylex.ts";

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
    backgroundColor: { default: "transparent", [enabledHover]: color.sidebarRowHover },
    color: { default: color.mutedForeground, [enabledHover]: color.foreground },
    cursor: "pointer",
    transitionProperty: "background-color, color",
    transitionDuration: "150ms",
  },
  pending: {
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
  error: { margin: 0, color: color.errorForeground, fontSize: 12, textAlign: "right" },
  positioner: { zIndex: 10 },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    width: "22rem",
    maxWidth: "var(--available-width)",
    maxHeight: "min(28rem, var(--available-height))",
    padding: space.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.medium,
    backgroundColor: color.card,
    color: color.foreground,
    boxShadow: "0 8px 24px rgb(0 0 0 / 12%)",
    fontFamily: font.sans,
    fontSize: 12,
    lineHeight: 1.45,
    WebkitFontSmoothing: "antialiased",
    opacity: 1,
    transitionProperty: "opacity",
    transitionDuration: { default: "150ms", [reducedMotion]: "0s" },
  },
  cardHidden: { opacity: 0 },
  cardTitle: { margin: 0, fontSize: 13, fontWeight: 600 },
  cardVersion: { margin: 0, color: color.mutedForeground, fontVariantNumeric: "tabular-nums" },
  notesHeading: { margin: 0, marginTop: 6, fontSize: 12, fontWeight: 600 },
  notes: {
    flexShrink: 1,
    minHeight: 0,
    maxHeight: "15rem",
    overflowY: "auto",
    margin: 0,
    paddingLeft: 16,
    color: color.mutedForeground,
    overflowWrap: "anywhere",
  },
  note: { marginBlock: 2 },
  releaseLink: {
    display: "inline-flex",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 4,
    flexShrink: 0,
    marginTop: 6,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: "transparent",
    color: { default: color.mutedForeground, ":hover": color.foreground },
    fontFamily: "inherit",
    fontSize: 12,
    cursor: "pointer",
  },
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

function ReleaseCard({ update }: { update: PendingUpdate }) {
  return (
    <Popover.Portal>
      <Popover.Positioner
        side="top"
        align="center"
        sideOffset={8}
        collisionPadding={8}
        {...stylex.props(styles.positioner)}
      >
        <Popover.Popup
          initialFocus={false}
          className={({ transitionStatus }) =>
            stylex.props(
              styles.card,
              (transitionStatus === "starting" || transitionStatus === "ending") &&
                styles.cardHidden,
            ).className
          }
        >
          <Popover.Title {...stylex.props(styles.cardTitle)}>
            {releaseCardTitle(update)}
          </Popover.Title>
          <p {...stylex.props(styles.cardVersion)}>Version {update.version}</p>
          {update.notes.length > 0 && (
            <>
              <h3 {...stylex.props(styles.notesHeading)}>What's changed</h3>
              <ul {...stylex.props(styles.notes)}>
                {update.notes.map((note) => (
                  <li key={note} {...stylex.props(styles.note)}>
                    {note}
                  </li>
                ))}
              </ul>
            </>
          )}
          <button
            type="button"
            onClick={() => void window.voice.openRelease()}
            {...stylex.props(styles.releaseLink)}
          >
            View release on GitHub
            <Glyph size={12}>
              <path d="M15 3h6v6" />
              <path d="M10 14 21 3" />
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            </Glyph>
          </button>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  );
}

export function SidebarUpdates({
  updates,
  session,
}: {
  updates: UpdatesSnapshot;
  session: PillState;
}) {
  const [actionError, setActionError] = useState("");
  const [cardOpen, setCardOpen] = useState(false);
  const focusReturnedByEscape = useRef(false);
  const status = updates.status;
  const { action, label, tooltip } = updateButton(status, session);
  const pending = pendingUpdate(status);
  if (cardOpen && !pending) setCardOpen(false);

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
      {/* One trigger for every status, so the button keeps focus when an update starts or finishes. */}
      <Popover.Root
        open={cardOpen}
        onOpenChange={(next, details) => {
          // A click runs the update action instead of pinning the card open.
          if (details.reason === "trigger-press") {
            details.cancel();
            return;
          }
          // Escape hands focus back to the trigger, which must not reopen the card.
          if (!next && details.reason === "escape-key") focusReturnedByEscape.current = true;
          setCardOpen(next);
        }}
      >
        <Popover.Trigger
          openOnHover={pending !== null}
          delay={100}
          closeDelay={150}
          aria-label={label}
          aria-haspopup={pending ? "dialog" : undefined}
          aria-expanded={pending ? cardOpen : undefined}
          // aria-disabled instead of disabled keeps the button hoverable and focusable for the card.
          aria-disabled={action === null || undefined}
          title={pending ? undefined : tooltip}
          onClick={() => {
            if (action === null) return;
            void run(() =>
              action === "restart"
                ? window.voice.restartForUpdate()
                : window.voice.checkForUpdates(),
            );
          }}
          onFocus={(event) => {
            if (
              pending &&
              !focusReturnedByEscape.current &&
              event.currentTarget.matches(":focus-visible")
            )
              setCardOpen(true);
            focusReturnedByEscape.current = false;
          }}
          {...stylex.props(
            styles.button,
            (status.kind === "ready" ||
              status.kind === "installing" ||
              status.kind === "downloading") &&
              styles.pending,
            status.kind === "failed" && styles.failed,
            status.kind === "disabled" && styles.dimmed,
            action === null && styles.unavailable,
          )}
        >
          <StatusIcon status={status} />
        </Popover.Trigger>
        {pending && <ReleaseCard update={pending} />}
      </Popover.Root>
      {actionError && (
        <p role="alert" {...stylex.props(styles.error)}>
          {actionError}
        </p>
      )}
    </div>
  );
}

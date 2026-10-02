import { Popover } from "@base-ui/react/popover";
import * as stylex from "@stylexjs/stylex";
import { useRef, useState, type ReactNode } from "react";

import type { PendingUpdate } from "../shared/api.ts";
import { releaseCardTitle, type UpdateCard } from "./updateStatus.ts";
import { color, font, radius, space } from "./tokens.stylex.ts";

const reducedMotion = "@media (prefers-reduced-motion: reduce)";

const styles = stylex.create({
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
  errorTitle: { color: color.errorForeground },
  errorMessage: { margin: 0, color: color.mutedForeground, overflowWrap: "anywhere" },
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

export function UpdateCardTrigger({
  card,
  label,
  disabled,
  onClick,
  style,
  children,
}: {
  card: UpdateCard | null;
  label: string;
  disabled: boolean;
  onClick: () => void;
  style: stylex.StyleXStyles;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const focusReturnedByEscape = useRef(false);
  if (open && !card) setOpen(false);

  return (
    // One trigger for every status, so the button keeps focus when an update starts or finishes.
    <Popover.Root
      open={open}
      onOpenChange={(next, details) => {
        // A click runs the button's action instead of pinning the card open.
        if (details.reason === "trigger-press") {
          details.cancel();
          return;
        }
        // Escape hands focus back to the trigger, which must not reopen the card.
        if (!next && details.reason === "escape-key") focusReturnedByEscape.current = true;
        setOpen(next);
      }}
    >
      <Popover.Trigger
        openOnHover={card !== null}
        delay={100}
        closeDelay={150}
        aria-label={label}
        aria-haspopup={card ? "dialog" : undefined}
        aria-expanded={card ? open : undefined}
        // aria-disabled instead of disabled keeps the button hoverable and focusable for the card.
        aria-disabled={disabled || undefined}
        title={card ? undefined : label}
        onClick={() => {
          if (!disabled) onClick();
        }}
        onFocus={(event) => {
          if (
            card &&
            !focusReturnedByEscape.current &&
            event.currentTarget.matches(":focus-visible")
          )
            setOpen(true);
          focusReturnedByEscape.current = false;
        }}
        {...stylex.props(style)}
      >
        {children}
      </Popover.Trigger>
      {card && (
        <CardPopup>
          {card.kind === "release" ? (
            <ReleaseCard update={card.update} />
          ) : (
            <ErrorCard message={card.message} />
          )}
        </CardPopup>
      )}
    </Popover.Root>
  );
}

function CardPopup({ children }: { children: ReactNode }) {
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
          {children}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <>
      <Popover.Title {...stylex.props(styles.cardTitle, styles.errorTitle)}>
        Update failed
      </Popover.Title>
      <Popover.Description {...stylex.props(styles.errorMessage)}>{message}</Popover.Description>
    </>
  );
}

function ReleaseCard({ update }: { update: PendingUpdate }) {
  return (
    <>
      <Popover.Title {...stylex.props(styles.cardTitle)}>{releaseCardTitle(update)}</Popover.Title>
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
        <svg
          aria-hidden="true"
          width={12}
          height={12}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M15 3h6v6" />
          <path d="M10 14 21 3" />
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        </svg>
      </button>
    </>
  );
}

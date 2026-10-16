import { Popover } from "@base-ui/react/popover";
import * as stylex from "@stylexjs/stylex";
import { ExternalLinkIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import type { PendingUpdate } from "../shared/api.ts";
import { releaseCardTitle, type UpdateCard } from "./updateStatus.ts";
import { color, font, motion, radius, space } from "./tokens.stylex.ts";
import { hubApi } from "./voice.ts";

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
    transitionDuration: {
      default: `calc(150ms * ${motion["--motion-scale"]})`,
      [reducedMotion]: "0s",
    },
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
    color: color.mutedForeground,
    overflowWrap: "anywhere",
  },
  release: { marginTop: { default: 6, ":first-child": 0 } },
  releaseVersion: { margin: 0, color: color.foreground, fontSize: 12, fontWeight: 500 },
  noteList: { margin: 0, paddingLeft: 16 },
  note: { marginBlock: 2 },
  more: { margin: 0, marginTop: 6 },
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
  const { releases, more } = update.notes;
  return (
    <>
      <Popover.Title {...stylex.props(styles.cardTitle)}>{releaseCardTitle(update)}</Popover.Title>
      {releases.length > 0 && (
        <>
          <h3 {...stylex.props(styles.notesHeading)}>What's changed</h3>
          <div {...stylex.props(styles.notes)}>
            {releases.map(({ version, items }) => (
              <section key={version} {...stylex.props(styles.release)}>
                {releases.length > 1 && <h4 {...stylex.props(styles.releaseVersion)}>{version}</h4>}
                <ul {...stylex.props(styles.noteList)}>
                  {items.map((item) => (
                    <li key={item} {...stylex.props(styles.note)}>
                      {item}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {more && <p {...stylex.props(styles.more)}>And earlier releases</p>}
          </div>
        </>
      )}
      <button
        type="button"
        onClick={() => void hubApi().openRelease()}
        {...stylex.props(styles.releaseLink)}
      >
        View release on GitHub
        <ExternalLinkIcon size={12} />
      </button>
    </>
  );
}

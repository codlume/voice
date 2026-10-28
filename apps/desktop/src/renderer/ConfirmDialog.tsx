import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog } from "@base-ui/react/dialog";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode, RefObject } from "react";

import { Button } from "./Button.tsx";
import { color, font, radius, space } from "./tokens.stylex.ts";

const reducedMotion = "@media (prefers-reduced-motion: reduce)";
const dark = "@media (prefers-color-scheme: dark)";
const centered = "translate(-50%, -50%)";

export const dialogStyles = stylex.create({
  backdrop: {
    position: "fixed",
    inset: 0,
    // The dark hub is already near black, so a light scrim would not separate the dialog.
    backgroundColor: { default: "rgb(0 0 0 / 32%)", [dark]: "rgb(0 0 0 / 60%)" },
    opacity: 1,
    transitionProperty: "opacity",
    transitionDuration: { default: "150ms", [reducedMotion]: "0s" },
  },
  backdropHidden: { opacity: 0 },
  surface: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.large,
    color: color.foreground,
    fontFamily: font.sans,
    WebkitFontSmoothing: "antialiased",
    boxShadow: "0 12px 32px -8px rgb(0 0 0 / 25%)",
    outline: "none",
    opacity: 1,
    transitionProperty: "opacity, transform",
    transitionDuration: { default: "150ms", [reducedMotion]: "0s" },
  },
  surfaceHidden: { opacity: 0 },
});

const styles = stylex.create({
  popup: {
    position: "fixed",
    top: "50%",
    left: "50%",
    width: "min(420px, calc(100vw - 32px))",
    padding: space.lg,
    backgroundColor: color.card,
    transform: centered,
  },
  popupWide: { width: "min(600px, calc(100vw - 32px))" },
  popupHidden: { transform: `${centered} scale(0.96)` },
  title: { margin: 0, fontSize: 15, fontWeight: 600, color: color.foreground },
  description: {
    marginTop: 6,
    marginBottom: 0,
    fontSize: 13,
    lineHeight: 1.45,
    color: color.mutedForeground,
  },
  // Buttons do not shrink, so a row wider than the popup must wrap rather than spill out. The
  // buttons wrap as a group, so a narrow row puts them under `footerStart` instead of splitting them.
  footer: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.sm,
    marginTop: space.lg,
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: space.sm,
    marginInlineStart: "auto",
  },
});

export const transitionHidden = (status: string | undefined) =>
  status === "starting" || status === "ending";

/** Base UI skips a nested dialog's backdrop by default. Forced so a confirm inside Settings dims Settings. */
export function DialogBackdrop() {
  return (
    <Dialog.Backdrop
      forceRender
      className={({ transitionStatus }) =>
        stylex.props(
          dialogStyles.backdrop,
          transitionHidden(transitionStatus) && dialogStyles.backdropHidden,
        ).className
      }
    />
  );
}

/**
 * Scrim, popup, title, and an action row of Cancel then `actions`, with optional `footerStart` at
 * its left. Renders under Dialog.Root or AlertDialog.Root.
 */
export function DialogFrame({
  title,
  actions,
  footerStart,
  finalFocus,
  wide = false,
  children,
}: {
  title: string;
  actions: ReactNode;
  footerStart?: ReactNode;
  finalFocus?: RefObject<HTMLElement | null> | undefined;
  wide?: boolean;
  children?: ReactNode;
}) {
  return (
    <Dialog.Portal>
      <DialogBackdrop />
      <Dialog.Popup
        finalFocus={finalFocus}
        className={({ transitionStatus }) =>
          stylex.props(
            dialogStyles.surface,
            styles.popup,
            wide && styles.popupWide,
            transitionHidden(transitionStatus) && [dialogStyles.surfaceHidden, styles.popupHidden],
          ).className
        }
      >
        <Dialog.Title {...stylex.props(styles.title)}>{title}</Dialog.Title>
        {children}
        {/* Cancel is the first button, so a dialog without fields opens on it and Enter cannot
            destroy anything. `footerStart` precedes Cancel in tab order and would take that focus,
            so pass it only in a dialog with fields. */}
        <div {...stylex.props(styles.footer)}>
          {footerStart}
          <div {...stylex.props(styles.actions)}>
            <Dialog.Close render={<Button variant="secondary" />}>Cancel</Dialog.Close>
            {actions}
          </div>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  );
}

type ConfirmAction = {
  label: string;
  variant: "primary" | "destructive";
  onClick: () => void;
};

export function ConfirmDialog({
  open,
  onOpenChange,
  onOpenChangeComplete,
  finalFocus,
  title,
  description,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete?: (open: boolean) => void;
  finalFocus?: RefObject<HTMLElement | null> | undefined;
  title: string;
  description: string;
  actions: readonly ConfirmAction[];
}) {
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <DialogFrame
        title={title}
        finalFocus={finalFocus}
        actions={actions.map(({ label, variant, onClick }) => (
          <AlertDialog.Close key={label} render={<Button variant={variant} />} onClick={onClick}>
            {label}
          </AlertDialog.Close>
        ))}
      >
        <AlertDialog.Description {...stylex.props(styles.description)}>
          {description}
        </AlertDialog.Description>
      </DialogFrame>
    </AlertDialog.Root>
  );
}

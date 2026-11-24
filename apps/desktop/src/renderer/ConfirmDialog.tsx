import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog } from "@base-ui/react/dialog";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode, RefObject } from "react";

import { Button } from "./Button.tsx";
import { surfaces } from "./surfaces.ts";
import { color, leading, motion, radius, space, text } from "./tokens.stylex.ts";

const centered = "translate(-50%, -50%)";

// Adapted dialog (MIT, see THIRD_PARTY_NOTICES.md): a blurred scrim, a frosted panel that scales in
// from 98%, and a tinted footer under a rule.
export const dialogStyles = stylex.create({
  backdrop: {
    opacity: 1,
    transitionProperty: "opacity",
    transitionDuration: { default: motion.slow, [motion.reduced]: "0s" },
  },
  backdropHidden: { opacity: 0 },
  surface: {
    opacity: 1,
    transitionProperty: "opacity, transform",
    transitionDuration: { default: motion.slow, [motion.reduced]: "0s" },
    transitionTimingFunction: motion.ease,
  },
  surfaceHidden: { opacity: 0 },
});

const styles = stylex.create({
  popup: {
    position: "fixed",
    top: "50%",
    left: "50%",
    display: "flex",
    flexDirection: "column",
    width: "min(512px, calc(100vw - 32px))",
    maxHeight: "calc(100vh - 32px)",
    transform: centered,
  },
  popupWide: { width: "min(600px, calc(100vw - 32px))" },
  popupHidden: { transform: `${centered} scale(0.98)` },
  header: { display: "flex", flexDirection: "column", gap: space.sm, padding: 24 },
  title: {
    margin: 0,
    fontSize: text.xl,
    fontWeight: 600,
    lineHeight: 1.375,
    overflowWrap: "anywhere",
  },
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: space.base,
    minHeight: 0,
    overflowY: "auto",
    paddingInline: 24,
    paddingBottom: 24,
    fontSize: text.sm,
    lineHeight: leading.sm,
  },
  description: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: color.mutedForeground,
  },
  footer: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.sm,
    paddingBlock: space.base,
    paddingInline: 24,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: color.border,
    borderBottomLeftRadius: `calc(${radius.xl} - 1px)`,
    borderBottomRightRadius: `calc(${radius.xl} - 1px)`,
    backgroundColor: `color-mix(in srgb, ${color.muted} 72%, transparent)`,
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
          surfaces.backdrop,
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
            surfaces.dialog,
            dialogStyles.surface,
            styles.popup,
            wide && styles.popupWide,
            transitionHidden(transitionStatus) && [dialogStyles.surfaceHidden, styles.popupHidden],
          ).className
        }
      >
        <div {...stylex.props(styles.header)}>
          <Dialog.Title {...stylex.props(styles.title)}>{title}</Dialog.Title>
        </div>
        {children && <div {...stylex.props(styles.panel)}>{children}</div>}
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

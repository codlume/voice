import { AlertDialog } from "@base-ui/react/alert-dialog";
import * as stylex from "@stylexjs/stylex";

import { Button } from "./Button.tsx";
import { color, font, radius, space } from "./tokens.stylex.ts";

const reducedMotion = "@media (prefers-reduced-motion: reduce)";
const dark = "@media (prefers-color-scheme: dark)";
const centered = "translate(-50%, -50%)";

const styles = stylex.create({
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
  popup: {
    position: "fixed",
    top: "50%",
    left: "50%",
    width: "min(360px, calc(100vw - 32px))",
    padding: space.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.large,
    backgroundColor: color.card,
    color: color.foreground,
    fontFamily: font.sans,
    WebkitFontSmoothing: "antialiased",
    boxShadow: "0 12px 32px -8px rgb(0 0 0 / 25%)",
    outline: "none",
    opacity: 1,
    transform: centered,
    transitionProperty: "opacity, transform",
    transitionDuration: { default: "150ms", [reducedMotion]: "0s" },
  },
  popupHidden: { opacity: 0, transform: `${centered} scale(0.96)` },
  title: { margin: 0, fontSize: 15, fontWeight: 600, color: color.foreground },
  description: {
    marginTop: 6,
    marginBottom: 0,
    fontSize: 13,
    lineHeight: 1.45,
    color: color.mutedForeground,
  },
  actions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: space.sm,
    marginTop: space.lg,
  },
});

type ConfirmAction = {
  label: string;
  variant: "primary" | "destructive";
  onClick: () => void;
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  actions: readonly ConfirmAction[];
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop
          className={({ transitionStatus }) =>
            stylex.props(
              styles.backdrop,
              (transitionStatus === "starting" || transitionStatus === "ending") &&
                styles.backdropHidden,
            ).className
          }
        />
        <AlertDialog.Popup
          className={({ transitionStatus }) =>
            stylex.props(
              styles.popup,
              (transitionStatus === "starting" || transitionStatus === "ending") &&
                styles.popupHidden,
            ).className
          }
        >
          <AlertDialog.Title {...stylex.props(styles.title)}>{title}</AlertDialog.Title>
          <AlertDialog.Description {...stylex.props(styles.description)}>
            {description}
          </AlertDialog.Description>
          <div {...stylex.props(styles.actions)}>
            {/* Cancel comes first so it takes initial focus and Enter cannot destroy anything. */}
            <AlertDialog.Close render={<Button variant="secondary" />}>Cancel</AlertDialog.Close>
            {actions.map(({ label, variant, onClick }) => (
              <AlertDialog.Close
                key={label}
                render={<Button variant={variant} />}
                onClick={onClick}
              >
                {label}
              </AlertDialog.Close>
            ))}
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

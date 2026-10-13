import { Tooltip } from "@base-ui/react/tooltip";
import * as stylex from "@stylexjs/stylex";
import { Undo2Icon } from "lucide-react";

import { color, radius } from "./tokens.stylex.ts";
import { tooltip } from "./tooltip.ts";

// The slot stays when the button is absent, so the title line keeps its height.
export const resetLayout = stylex.create({
  titleLine: { display: "flex", alignItems: "center", gap: 6, minHeight: 20 },
  slot: { display: "grid", flexShrink: 0, width: 20, height: 20 },
});

const styles = stylex.create({
  button: {
    display: "grid",
    placeItems: "center",
    width: 20,
    height: 20,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: "transparent", ":hover:not(:disabled)": color.accent },
    color: { default: color.mutedForeground, ":hover:not(:disabled)": color.foreground },
    cursor: { default: "pointer", ":disabled": "default" },
    outline: { default: "none", ":focus-visible": `2px solid ${color["--ring"]}` },
  },
});

export function ResetButton({
  label,
  disabled = false,
  onReset,
}: {
  label: string;
  disabled?: boolean;
  onReset: () => void;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={<button type="button" disabled={disabled} />}
        disabled={disabled}
        aria-label={`Reset ${label} to default`}
        onClick={onReset}
        {...stylex.props(styles.button)}
      >
        <Undo2Icon size={12} aria-hidden="true" />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="top" sideOffset={6} {...stylex.props(tooltip.positioner)}>
          <Tooltip.Popup
            className={({ transitionStatus, instant }) =>
              stylex.props(
                tooltip.popup,
                (transitionStatus === "starting" || transitionStatus === "ending") &&
                  tooltip.hidden,
                (instant === "focus" || instant === "dismiss") && tooltip.instant,
              ).className
            }
          >
            Reset to default
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

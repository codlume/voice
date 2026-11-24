import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { transitionHidden } from "./ConfirmDialog.tsx";
import { surfaces } from "./surfaces.ts";
import { leading, space, text } from "./tokens.stylex.ts";

// Adapted popover (MIT, see THIRD_PARTY_NOTICES.md): frosted, scaling in from its anchor.
const styles = stylex.create({
  positioner: { zIndex: 20 },
  popup: {
    maxWidth: "min(320px, var(--available-width))",
    padding: space.base,
  },
  title: { margin: 0, fontSize: text.sm, fontWeight: 600, lineHeight: 1 },
  description: { margin: 0, marginTop: space.sm, fontSize: text.sm, lineHeight: leading.sm },
});

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export function PopoverPopup({
  side = "bottom",
  align = "center",
  title,
  children,
}: {
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  title?: string;
  children: ReactNode;
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={4}
        {...stylex.props(styles.positioner)}
      >
        <PopoverPrimitive.Popup
          className={({ transitionStatus }) =>
            stylex.props(
              surfaces.popup,
              surfaces.popupMotion,
              styles.popup,
              transitionHidden(transitionStatus) && surfaces.popupHidden,
            ).className
          }
        >
          {title && (
            <PopoverPrimitive.Title {...stylex.props(styles.title)}>{title}</PopoverPrimitive.Title>
          )}
          <div {...stylex.props(title !== undefined && styles.description)}>{children}</div>
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

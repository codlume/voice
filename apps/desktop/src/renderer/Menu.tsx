import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { surfaces } from "./surfaces.ts";
import { color, icon } from "./tokens.stylex.ts";

// Adapted menu (MIT, see THIRD_PARTY_NOTICES.md): a frosted list of 28px rows that opens at once.
const styles = stylex.create({
  positioner: { zIndex: 20 },
  popup: {
    minWidth: "min(160px, var(--available-width))",
    maxHeight: "var(--available-height)",
    overflowY: "auto",
    padding: 4,
  },
  // Icons sit muted and a little faded until the row is destructive.
  item: { "--menu-icon": color.mutedForeground },
  destructive: { color: color.errorForeground, "--menu-icon": "currentColor" },
  icon: { display: "flex", flexShrink: 0, width: icon.md, color: "var(--menu-icon)", opacity: 0.8 },
});

export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;

export function MenuPopup({
  align = "start",
  children,
}: {
  align?: "start" | "center" | "end";
  children: ReactNode;
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner align={align} sideOffset={4} {...stylex.props(styles.positioner)}>
        <MenuPrimitive.Popup {...stylex.props(surfaces.popup, styles.popup)}>
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export function MenuItem({
  icon: glyph,
  destructive = false,
  disabled = false,
  onClick,
  children,
}: {
  icon?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <MenuPrimitive.Item
      disabled={disabled}
      onClick={onClick}
      className={({ highlighted }) =>
        stylex.props(
          surfaces.item,
          styles.item,
          destructive && styles.destructive,
          highlighted && surfaces.itemHighlighted,
          disabled && surfaces.itemDisabled,
        ).className
      }
    >
      {glyph && <span {...stylex.props(styles.icon)}>{glyph}</span>}
      {children}
    </MenuPrimitive.Item>
  );
}

export function MenuSeparator() {
  return <MenuPrimitive.Separator {...stylex.props(surfaces.separator)} />;
}

export function MenuGroupLabel({ children }: { children: ReactNode }) {
  return (
    <MenuPrimitive.Group>
      <MenuPrimitive.GroupLabel {...stylex.props(surfaces.groupLabel)}>
        {children}
      </MenuPrimitive.GroupLabel>
    </MenuPrimitive.Group>
  );
}

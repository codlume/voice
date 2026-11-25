import { Select as SelectPrimitive } from "@base-ui/react/select";
import * as stylex from "@stylexjs/stylex";
import { ChevronDownIcon } from "lucide-react";

import { surfaces } from "./surfaces.ts";
import { color, font, leading, space, text } from "./tokens.stylex.ts";

// Adapted select (MIT, see THIRD_PARTY_NOTICES.md): a 32px bordered trigger and a frosted list.
const styles = stylex.create({
  trigger: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexShrink: 0,
    gap: space.sm,
    minWidth: 144,
    maxWidth: "min(240px, 48%)",
    height: 32,
    paddingInline: 11,
    fontFamily: font.sans,
    fontSize: text.sm,
    lineHeight: leading.sm,
    textAlign: "left",
    cursor: "pointer",
    userSelect: "none",
  },
  disabled: { cursor: "default", opacity: 0.64 },
  value: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  icon: { display: "flex", flexShrink: 0, marginInlineEnd: -4, opacity: 0.7 },
  positioner: { zIndex: 10 },
  popup: {
    minWidth: "var(--anchor-width)",
    maxWidth: "var(--available-width)",
    overflow: "hidden",
  },
  list: {
    maxHeight: "min(320px, var(--available-height))",
    overflowY: "auto",
    overscrollBehavior: "contain",
    padding: 4,
  },
  selected: { backgroundColor: `color-mix(in srgb, ${color.foreground} 8%, transparent)` },
});

export function Select<T extends string>({
  id,
  value,
  options,
  disabled = false,
  style,
  onChange,
}: {
  id: string;
  value: T;
  options: readonly { value: T; label: string }[];
  disabled?: boolean;
  style?: stylex.StyleXStyles;
  onChange: (value: T) => void;
}) {
  return (
    <SelectPrimitive.Root<T>
      value={value}
      items={options}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectPrimitive.Trigger
        id={id}
        {...stylex.props(surfaces.control, styles.trigger, disabled && styles.disabled, style)}
      >
        <SelectPrimitive.Value {...stylex.props(styles.value)} />
        <SelectPrimitive.Icon {...stylex.props(styles.icon)}>
          <ChevronDownIcon size={14} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          align="start"
          alignItemWithTrigger={false}
          sideOffset={4}
          {...stylex.props(styles.positioner)}
        >
          <SelectPrimitive.Popup {...stylex.props(surfaces.popup, styles.popup)}>
            <SelectPrimitive.List {...stylex.props(styles.list)}>
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  className={({ selected, highlighted }) =>
                    stylex.props(
                      surfaces.item,
                      selected && styles.selected,
                      highlighted && surfaces.itemHighlighted,
                    ).className
                  }
                >
                  <SelectPrimitive.ItemText {...stylex.props(styles.value)}>
                    {option.label}
                  </SelectPrimitive.ItemText>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

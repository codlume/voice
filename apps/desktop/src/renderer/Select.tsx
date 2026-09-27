import { Select as SelectPrimitive } from "@base-ui/react/select";
import * as stylex from "@stylexjs/stylex";

import { color, font, radius, space } from "./tokens.stylex.ts";

const styles = stylex.create({
  trigger: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexShrink: 0,
    gap: space.sm,
    minWidth: 110,
    paddingBlock: 6,
    paddingInline: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.medium,
    backgroundColor: { default: color.card, ":hover": color.accent },
    color: color.foreground,
    fontFamily: font.sans,
    fontSize: 13,
    lineHeight: 1.45,
    textAlign: "left",
    cursor: "pointer",
    userSelect: "none",
  },
  disabled: { cursor: "default" },
  value: { flexGrow: 1, whiteSpace: "nowrap" },
  icon: { display: "flex", flexShrink: 0, color: color.mutedForeground },
  positioner: { zIndex: 10 },
  popup: {
    minWidth: "var(--anchor-width)",
    maxWidth: "var(--available-width)",
    overflow: "hidden",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.medium,
    backgroundColor: color.card,
    color: color.foreground,
    fontFamily: font.sans,
    fontSize: 13,
    lineHeight: 1.45,
    WebkitFontSmoothing: "antialiased",
    boxShadow: "0 12px 32px -8px rgb(0 0 0 / 25%)",
    outline: "none",
  },
  list: {
    maxHeight: "min(320px, var(--available-height))",
    overflowY: "auto",
    overscrollBehavior: "contain",
    padding: 4,
  },
  item: {
    display: "flex",
    alignItems: "center",
    minHeight: 30,
    paddingBlock: 5,
    paddingInline: space.sm,
    borderRadius: radius.small,
    cursor: "pointer",
    userSelect: "none",
    outline: "none",
  },
  selected: { backgroundColor: color.segmentTrack },
  highlighted: { backgroundColor: color.input },
});

export function Select<T extends string>({
  id,
  value,
  options,
  disabled = false,
  onChange,
}: {
  id: string;
  value: T;
  options: readonly { value: T; label: string }[];
  disabled?: boolean;
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
        {...stylex.props(styles.trigger, disabled && styles.disabled)}
      >
        <SelectPrimitive.Value {...stylex.props(styles.value)} />
        <SelectPrimitive.Icon {...stylex.props(styles.icon)}>
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m5 7.5 5 5 5-5" />
          </svg>
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          align="start"
          alignItemWithTrigger={false}
          sideOffset={4}
          {...stylex.props(styles.positioner)}
        >
          <SelectPrimitive.Popup {...stylex.props(styles.popup)}>
            <SelectPrimitive.List {...stylex.props(styles.list)}>
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  className={({ selected, highlighted }) =>
                    stylex.props(
                      styles.item,
                      selected && styles.selected,
                      highlighted && styles.highlighted,
                    ).className
                  }
                >
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import * as stylex from "@stylexjs/stylex";

import { color, elevation, motion, radius } from "./tokens.stylex.ts";

// Adapted switch (MIT, see THIRD_PARTY_NOTICES.md): a 16px thumb that stretches while pressed.
const thumbSize = 16;

const styles = stylex.create({
  switch: {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    width: thumbSize * 2 - 2,
    height: thumbSize + 2,
    padding: 2,
    borderWidth: 0,
    borderRadius: radius.round,
    backgroundColor: color.input,
    cursor: "pointer",
    transitionProperty: "background-color, box-shadow",
    transitionDuration: { default: motion.slow, [motion.reduced]: "0s" },
  },
  switchOn: { backgroundColor: color.primary },
  disabled: { opacity: 0.64, cursor: "not-allowed" },
  thumb: {
    display: "block",
    flexShrink: 0,
    width: thumbSize - 2,
    height: thumbSize - 2,
    borderRadius: thumbSize,
    backgroundColor: { default: color.background, [motion.dark]: color.mutedForeground },
    boxShadow: elevation.sm,
    pointerEvents: "none",
    transformOrigin: "left",
    transitionProperty: "translate, border-radius, scale, transform-origin",
    transitionDuration: { default: "150ms, 150ms, 100ms, 150ms", [motion.reduced]: "0s" },
    transitionDelay: "0s, 0s, 100ms, 0s",
    scale: { default: 1, [stylex.when.ancestor(":active")]: "1.1 1" },
  },
  thumbOn: {
    translate: `${thumbSize - 4}px 0`,
    transformOrigin: "right",
    backgroundColor: color.background,
  },
});

export function Switch({
  checked,
  disabled = false,
  onChange,
  id,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  id: string;
}) {
  return (
    <SwitchPrimitive.Root
      id={id}
      nativeButton
      render={<button />}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      {...stylex.props(
        stylex.defaultMarker(),
        styles.switch,
        checked && styles.switchOn,
        disabled && styles.disabled,
      )}
    >
      <SwitchPrimitive.Thumb {...stylex.props(styles.thumb, checked && styles.thumbOn)} />
    </SwitchPrimitive.Root>
  );
}

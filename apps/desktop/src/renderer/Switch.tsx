import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import * as stylex from "@stylexjs/stylex";

import { color, radius } from "./tokens.stylex.ts";

const styles = stylex.create({
  switch: {
    position: "relative",
    flexShrink: 0,
    width: 36,
    height: 22,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.round,
    backgroundColor: color.input,
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: { default: "160ms", "@media (prefers-reduced-motion: reduce)": "0s" },
  },
  switchOn: { backgroundColor: color.primary },
  disabled: { opacity: 0.5, cursor: "default" },
  thumb: {
    position: "absolute",
    top: 2,
    left: 2,
    width: 18,
    height: 18,
    borderRadius: radius.round,
    backgroundColor: color.primaryForeground,
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.2)",
    transitionProperty: "transform",
    transitionDuration: { default: "160ms", "@media (prefers-reduced-motion: reduce)": "0s" },
  },
  thumbOn: { transform: "translateX(14px)" },
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
      {...stylex.props(styles.switch, checked && styles.switchOn, disabled && styles.disabled)}
    >
      <SwitchPrimitive.Thumb {...stylex.props(styles.thumb, checked && styles.thumbOn)} />
    </SwitchPrimitive.Root>
  );
}

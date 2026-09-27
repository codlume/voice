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
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      {...stylex.props(styles.switch, checked && styles.switchOn)}
    >
      <span {...stylex.props(styles.thumb, checked && styles.thumbOn)} />
    </button>
  );
}

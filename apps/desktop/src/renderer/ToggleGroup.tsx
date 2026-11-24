import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import * as stylex from "@stylexjs/stylex";

import { color, leading, motion, radius, text } from "./tokens.stylex.ts";

// Adapted segmented toggle (MIT, see THIRD_PARTY_NOTICES.md): muted labels on a tinted track, the
// pressed one lifted onto the background. Settings radios share the look.
export const segmentStyles = stylex.create({
  track: {
    display: "grid",
    gridAutoFlow: "column",
    gridAutoColumns: "1fr",
    gap: 2,
    padding: 2,
    borderRadius: radius.medium,
    backgroundColor: color.segmentTrack,
  },
  segment: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: 28,
    paddingInline: 11,
    borderRadius: radius.small,
    color: { default: color.mutedForeground, ":hover": color.foreground },
    backgroundColor: {
      default: "transparent",
      ":hover": `color-mix(in srgb, ${color.background} 55%, transparent)`,
    },
    fontSize: text.sm,
    fontWeight: 500,
    lineHeight: leading.sm,
    whiteSpace: "nowrap",
    cursor: "pointer",
    transitionProperty: "color, background-color",
    transitionDuration: { default: motion.base, [motion.reduced]: "0s" },
  },
  on: {
    backgroundColor: { default: color.segmentSelected, ":hover": color.segmentSelected },
    color: color.foreground,
    boxShadow: "0 1px 2px 0 rgb(0 0 0 / 10%)",
  },
});

/** One choice of several, such as a tab bar. Name the group with `label`. */
export function ToggleGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <ToggleGroupPrimitive
      aria-label={label}
      value={[value]}
      onValueChange={(next) => {
        const [picked] = next as T[];
        if (picked !== undefined) onChange(picked);
      }}
      {...stylex.props(segmentStyles.track)}
    >
      {options.map((option) => (
        <Toggle
          key={option.value}
          value={option.value}
          {...stylex.props(segmentStyles.segment, option.value === value && segmentStyles.on)}
        >
          {option.label}
        </Toggle>
      ))}
    </ToggleGroupPrimitive>
  );
}

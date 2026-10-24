import { Slider } from "@base-ui/react/slider";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import { color, radius, space } from "./tokens.stylex.ts";

const sliderStyles = stylex.create({
  root: { display: "flex", alignItems: "center", gap: space.md },
  readout: {
    minWidth: 64,
    paddingBlock: 4,
    paddingInline: space.sm,
    borderRadius: radius.small,
    backgroundColor: color.segmentTrack,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 12,
    fontWeight: 500,
    fontVariantNumeric: "tabular-nums",
    textAlign: "center",
  },
  slider: { flexGrow: 1, minWidth: 0 },
  control: {
    display: "flex",
    alignItems: "center",
    height: 24,
    cursor: { default: "pointer", ":is([data-disabled])": "default" },
    touchAction: "none",
  },
  track: {
    position: "relative",
    width: "100%",
    height: 6,
    borderRadius: radius.round,
    backgroundColor: `color-mix(in srgb, ${color.mutedForeground} 22%, transparent)`,
    boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color.border} 55%, transparent)`,
  },
  indicator: { borderRadius: radius.round, backgroundColor: color.primary },
  thumb: {
    width: 16,
    height: 16,
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: color.primary,
    borderRadius: radius.round,
    backgroundColor: color.background,
    boxShadow: {
      default: "0 1px 2px rgb(0 0 0 / 12%)",
      ":hover": "0 1px 3px rgb(0 0 0 / 20%)",
    },
    transform: {
      default: null,
      ":hover": "scale(1.08)",
      ":active": "scale(0.94)",
      ":is([data-dragging])": "scale(0.94)",
    },
    transitionProperty: "transform, box-shadow",
    transitionDuration: { default: "120ms", "@media (prefers-reduced-motion: reduce)": "0s" },
    transitionTimingFunction: "ease",
    outline: { default: "none", ":has(:focus-visible)": `2px solid ${color["--ring"]}` },
    outlineOffset: 2,
  },
});

// Saving every drag tick would write settings.json and broadcast a snapshot per tick, so the thumb
// holds its own value and saves once the gesture or key press commits.
export function CommitSlider({
  saved,
  onCommit,
  min,
  max,
  step,
  readout,
  label,
  valueText,
  disabled = false,
}: {
  saved: number;
  onCommit: (value: number) => Promise<boolean>;
  min: number;
  max: number;
  step: number;
  readout: (value: number) => string;
  label: string;
  valueText: (value: number) => string;
  disabled?: boolean;
}) {
  const [slider, setSlider] = useState({ value: saved, saved });
  if (saved !== slider.saved) setSlider({ value: saved, saved });
  const { value } = slider;
  return (
    <div {...stylex.props(sliderStyles.root)}>
      <span aria-hidden {...stylex.props(sliderStyles.readout)}>
        {readout(value)}
      </span>
      <Slider.Root
        value={value}
        onValueChange={(next) => setSlider((current) => ({ ...current, value: next }))}
        onValueCommitted={(committed) => {
          void onCommit(committed).then((ok) => {
            // The updater reads the newest saved value, which another save may have changed since.
            if (!ok) setSlider((current) => ({ ...current, value: current.saved }));
          });
        }}
        min={min}
        max={max}
        step={step}
        largeStep={4 * step}
        disabled={disabled}
        {...stylex.props(sliderStyles.slider)}
      >
        <Slider.Control {...stylex.props(sliderStyles.control)}>
          <Slider.Track {...stylex.props(sliderStyles.track)}>
            <Slider.Indicator {...stylex.props(sliderStyles.indicator)} />
            <Slider.Thumb
              aria-label={label}
              getAriaValueText={(_, current) => valueText(current)}
              {...stylex.props(sliderStyles.thumb)}
            />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
    </div>
  );
}

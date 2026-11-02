import { Field } from "@base-ui/react/field";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import * as stylex from "@stylexjs/stylex";
import { useId, type ReactNode } from "react";

import type { SettingsPatch } from "../shared/api.ts";
import { SettingTitle } from "./SettingTitle.tsx";
import { color, radius, space } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";

export const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.xl },
  section: { display: "flex", flexDirection: "column", gap: space.sm },
  sectionLabel: { margin: 0, fontSize: 13, fontWeight: 600 },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.lg,
    paddingBlock: 14,
    paddingInline: space.lg,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  disabled: { opacity: 0.45 },
  rowText: { flexGrow: 1, minWidth: 0 },
  rowTitle: { display: "block", fontWeight: 500 },
  rowDetail: { margin: 0, color: color.mutedForeground, fontSize: 12.5 },
  segments: {
    display: "grid",
    gridAutoFlow: "column",
    gridAutoColumns: "1fr",
    gap: 2,
    padding: 3,
    borderRadius: radius.medium,
    backgroundColor: color.segmentTrack,
  },
  segment: {
    position: "relative",
    paddingBlock: 6,
    paddingInline: space.md,
    borderRadius: 7,
    color: color.mutedForeground,
    fontSize: 13,
    textAlign: "center",
    cursor: "pointer",
    outline: { default: "none", ":focus-visible": `2px solid ${color["--ring"]}` },
  },
  segmentOn: {
    backgroundColor: color.segmentSelected,
    color: color.foreground,
    fontWeight: 500,
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.1)",
  },
  actions: { display: "flex", gap: space.sm },
  hint: { margin: 0, color: color.mutedForeground, fontSize: 12.5 },
  link: { textDecoration: "underline" },
});

type Action = ReturnType<typeof useAction>;

export function update(action: Action, patch: SettingsPatch) {
  return action.run(() => hubApi().updateSettings(patch), "Could not save settings.");
}

export function GlobeHint() {
  return (
    <p {...stylex.props(styles.hint)}>
      If the Globe key opens the emoji picker, set System Settings &gt; Keyboard &gt; &ldquo;Press
      🌐 key to&rdquo; to &ldquo;Do Nothing&rdquo;.
    </p>
  );
}

// Undefined while the value already equals its default, which hides the reset button.
export function resetTo<T>(
  value: T,
  defaultValue: T,
  change: (value: T) => void,
): (() => void) | undefined {
  return value === defaultValue ? undefined : () => change(defaultValue);
}

export function Row({
  title,
  detail,
  disabled = false,
  nativeLabel = false,
  onReset,
  children,
}: {
  title: string;
  detail: string;
  disabled?: boolean;
  nativeLabel?: boolean;
  onReset: (() => void) | undefined;
  children: ReactNode;
}) {
  return (
    <Field.Root {...stylex.props(styles.row, disabled && styles.disabled)}>
      <div {...stylex.props(styles.rowText)}>
        <SettingTitle
          title={title}
          nativeLabel={nativeLabel}
          onReset={onReset}
          disabled={disabled}
        />
        <p {...stylex.props(styles.rowDetail)}>{detail}</p>
      </div>
      {children}
    </Field.Root>
  );
}

export function Section({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} {...stylex.props(styles.section)}>
      <h2 id={id} {...stylex.props(styles.sectionLabel)}>
        {label}
      </h2>
      {children}
    </section>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const id = useId();
  return (
    <RadioGroup<T> value={value} onValueChange={onChange} {...stylex.props(styles.segments)}>
      {options.map((option) => (
        // Inside a Field, Base UI labels each radio with the field's label, so each option points
        // at its own text to keep its name.
        <Radio.Root
          key={option.value}
          value={option.value}
          aria-labelledby={`${id}-${option.value}`}
          {...stylex.props(styles.segment, option.value === value && styles.segmentOn)}
        >
          <span id={`${id}-${option.value}`}>{option.label}</span>
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}

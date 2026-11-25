import { Field } from "@base-ui/react/field";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import * as stylex from "@stylexjs/stylex";
import { useId, type ReactNode } from "react";

import type { SettingsPatch } from "../shared/api.ts";
import { SettingTitle } from "./SettingTitle.tsx";
import { segmentStyles } from "./ToggleGroup.tsx";
import { color, leading, space, text } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";

// Adapted settings layout (MIT, see THIRD_PARTY_NOTICES.md): a semibold section title over a
// group card whose rows put a medium title and a small muted description left of the control.
export const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.xl },
  section: { display: "flex", flexDirection: "column", gap: 10 },
  // The label lines up with the row text below it.
  sectionLabel: {
    margin: 0,
    paddingInline: space.base,
    fontSize: text.base,
    fontWeight: 600,
    lineHeight: leading.base,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.xl,
    paddingBlock: space.md,
    paddingInline: space.base,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: `color-mix(in srgb, ${color.border} 50%, transparent)`,
  },
  disabled: { opacity: 0.64 },
  rowText: { flexGrow: 1, minWidth: 0 },
  rowTitle: { display: "block", fontSize: text.sm, fontWeight: 500, lineHeight: leading.sm },
  rowDetail: {
    margin: 0,
    maxWidth: 672,
    color: color.mutedForeground,
    fontSize: text.xs,
    lineHeight: 1.5,
    textWrap: "pretty",
  },
  actions: { display: "flex", gap: space.sm },
  // Every select in a settings row has one width, so the controls line up down the page.
  select: { width: 160, minWidth: 160, maxWidth: "none" },
  hint: { margin: 0, color: color.mutedForeground, fontSize: text.xs, lineHeight: leading.xs },
  // A hint or error under a card, indented like the section label.
  note: { paddingInline: space.base },
  link: { textDecoration: "underline" },
});

type Action = ReturnType<typeof useAction>;

export function update(action: Action, patch: SettingsPatch) {
  return action.run(() => hubApi().updateSettings(patch), "Could not save settings.");
}

export function GlobeHint({ style }: { style?: stylex.StyleXStyles }) {
  return (
    <p {...stylex.props(styles.hint, style)}>
      If the Globe key opens the emoji picker, set System Settings &gt; Keyboard &gt; &ldquo;Press
      🌐 key to&rdquo; to &ldquo;Do Nothing&rdquo;.
    </p>
  );
}

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
    <RadioGroup<T> value={value} onValueChange={onChange} {...stylex.props(segmentStyles.track)}>
      {options.map((option) => (
        // Inside a Field, Base UI labels each radio with the field's label, so each option points
        // at its own text to keep its name.
        <Radio.Root
          key={option.value}
          value={option.value}
          aria-labelledby={`${id}-${option.value}`}
          {...stylex.props(segmentStyles.segment, option.value === value && segmentStyles.on)}
        >
          <span id={`${id}-${option.value}`}>{option.label}</span>
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}

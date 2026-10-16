import { Field } from "@base-ui/react/field";
import { Tooltip } from "@base-ui/react/tooltip";
import * as stylex from "@stylexjs/stylex";
import { Undo2Icon } from "lucide-react";
import { useRef } from "react";

import { color, radius } from "./tokens.stylex.ts";
import { tooltipPopupClass, tooltipPositionerClass } from "./tooltip.ts";

const styles = stylex.create({
  // The slot stays when the button is absent, so the title line keeps its height.
  line: { display: "flex", alignItems: "center", gap: 6, minHeight: 20 },
  title: { display: "block", fontWeight: 500 },
  slot: { display: "grid", flexShrink: 0, width: 20, height: 20 },
  button: {
    display: "grid",
    placeItems: "center",
    width: 20,
    height: 20,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: "transparent", ":hover:not(:disabled)": color.accent },
    color: { default: color.mutedForeground, ":hover:not(:disabled)": color.foreground },
    cursor: { default: "pointer", ":disabled": "default" },
    opacity: { default: 1, ":disabled": 0.45 },
    outline: { default: "none", ":focus-visible": `2px solid ${color["--ring"]}` },
  },
});

// A composite control takes focus on the part a keyboard user acts on.
const focusablePart: Record<string, string> = {
  radiogroup: '[role="radio"][aria-checked="true"]',
  group: 'input[type="range"]',
};

// A reset hides its own button, so focus moves to the control the title labels. Base UI labels
// every control (Select trigger, Switch, RadioGroup, Slider) by the label's id through
// aria-labelledby.
function focusLabelledControl(label: HTMLElement | null) {
  if (!label?.id) return;
  const control = label.ownerDocument.querySelector<HTMLElement>(
    `[role][aria-labelledby~="${CSS.escape(label.id)}"]`,
  );
  const part = focusablePart[control?.getAttribute("role") ?? ""];
  const target = part ? control?.querySelector<HTMLElement>(part) : control;
  target?.focus();
}

function ResetButton({
  title,
  disabled,
  onReset,
}: {
  title: string;
  disabled: boolean;
  onReset: () => void;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={<button type="button" disabled={disabled} />}
        disabled={disabled}
        aria-label={`Reset ${title} to default`}
        onClick={onReset}
        {...stylex.props(styles.button)}
      >
        <Undo2Icon size={12} aria-hidden="true" />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="top" sideOffset={6} className={tooltipPositionerClass()}>
          <Tooltip.Popup className={tooltipPopupClass()}>Reset to default</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

// A native label passes its :hover and clicks to the labelled control, which is wrong for Select
// triggers. Switch rows opt in to keep click-to-toggle on the title. The reset button sits beside
// the label, not inside it, so it stays out of the control's accessible name and click target.
export function SettingTitle({
  title,
  nativeLabel = false,
  onReset,
  disabled = false,
}: {
  title: string;
  nativeLabel?: boolean;
  onReset: (() => void) | undefined;
  disabled?: boolean;
}) {
  const labelRef = useRef<HTMLElement>(null);
  return (
    <div {...stylex.props(styles.line)}>
      <Field.Label
        ref={labelRef}
        nativeLabel={nativeLabel}
        render={nativeLabel ? undefined : <div />}
        {...stylex.props(styles.title)}
      >
        {title}
      </Field.Label>
      <span {...stylex.props(styles.slot)}>
        {onReset && (
          <ResetButton
            title={title}
            disabled={disabled}
            onReset={() => {
              onReset();
              focusLabelledControl(labelRef.current);
            }}
          />
        )}
      </span>
    </div>
  );
}

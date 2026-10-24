import * as stylex from "@stylexjs/stylex";
import { useId, useState, type KeyboardEvent } from "react";

import type { Hotkey } from "../shared/api.ts";
import type { Modifier, Shortcut, Transform } from "../shared/transforms.ts";
import { Button } from "./Button.tsx";
import { Keys } from "./Keycap.tsx";
import { pageStyles } from "./pageStyles.ts";
import { styles as form } from "./RecordList.tsx";
import { styles as settings } from "./Settings.tsx";
import {
  capture,
  heldModifiers,
  modifierKeys,
  shortcutKeys,
  shortcutNotes,
  type KeyboardLayout,
} from "./shortcutCapture.ts";
import { color, radius, space } from "./tokens.stylex.ts";

const styles = stylex.create({
  row: { display: "flex", alignItems: "center", gap: space.sm },
  picker: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    minWidth: 160,
    minHeight: 32,
    paddingBlock: 4,
    paddingInline: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: color.border, ":focus": color.input },
    borderRadius: radius.medium,
    backgroundColor: color.card,
    color: color.foreground,
    font: "inherit",
    fontSize: 13,
    textAlign: "left",
    cursor: "pointer",
  },
  recording: { borderColor: { default: color.primary, ":focus": color.primary } },
  placeholder: { color: color.mutedForeground },
});

type Recording = { modifiers: readonly Modifier[]; refusal: string | null };

export function ShortcutPicker({
  value,
  others,
  layout,
  dictationKeys,
  invalid,
  onChange,
}: {
  value: Shortcut | null;
  others: readonly Transform[];
  layout: KeyboardLayout | null;
  dictationKeys: readonly Hotkey[];
  invalid: boolean;
  onChange: (shortcut: Shortcut | null) => void;
}) {
  const labelId = useId();
  const hintId = useId();
  const [recording, setRecording] = useState<Recording | null>(null);
  const start = () => setRecording({ modifiers: [], refusal: null });

  function onKeyDown(event: KeyboardEvent) {
    if (recording === null) return;
    const result = capture(event, { others, layout });
    if (result.kind === "pass") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    switch (result.kind) {
      case "cancel":
        setRecording(null);
        return;
      case "clear":
        onChange(null);
        setRecording(null);
        return;
      case "pending":
        setRecording({ modifiers: result.modifiers, refusal: null });
        return;
      case "refused":
        setRecording({ modifiers: [], refusal: result.message });
        return;
      case "recorded":
        onChange(result.shortcut);
        setRecording(null);
    }
  }

  const notes = value === null ? [] : shortcutNotes(value, dictationKeys);
  return (
    <div {...stylex.props(form.field)}>
      <span id={labelId} {...stylex.props(settings.sectionLabel)}>
        Shortcut
      </span>
      <div {...stylex.props(styles.row)}>
        <button
          type="button"
          aria-labelledby={labelId}
          aria-describedby={hintId}
          aria-invalid={invalid || undefined}
          onFocus={start}
          onClick={start}
          onBlur={() => setRecording(null)}
          onKeyDown={onKeyDown}
          onKeyUp={(event) => {
            if (recording && recording.refusal === null) {
              setRecording({ modifiers: heldModifiers(event), refusal: null });
            }
          }}
          {...stylex.props(
            styles.picker,
            invalid && form.invalid,
            recording !== null && styles.recording,
          )}
        >
          {recording !== null ? (
            recording.modifiers.length > 0 ? (
              <Keys keys={modifierKeys(recording.modifiers)} />
            ) : (
              <span {...stylex.props(styles.placeholder)}>Type a shortcut</span>
            )
          ) : value !== null ? (
            <Keys keys={shortcutKeys(value, layout)} />
          ) : (
            <span {...stylex.props(styles.placeholder)}>None</span>
          )}
        </button>
        {value !== null && recording === null && (
          <Button variant="text" onClick={() => onChange(null)}>
            Remove
          </Button>
        )}
      </div>
      <p id={hintId} {...stylex.props(settings.hint)}>
        {recording !== null
          ? "Hold Control, Option or Command and press a key. Backspace removes the shortcut. Escape stops recording."
          : "Click to record a shortcut."}
      </p>
      {recording?.refusal && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {recording.refusal}
        </p>
      )}
      {recording === null &&
        notes.map((note) => (
          <p key={note} {...stylex.props(settings.hint)}>
            {note}
          </p>
        ))}
    </div>
  );
}

import { Field } from "@base-ui/react/field";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import type { Hotkey } from "../shared/api.ts";
import {
  INSTRUCTION_MAX_LENGTH,
  TRANSFORM_NAME_MAX_LENGTH,
  type ShortcutHolder,
  type Transform,
  type TransformProblem,
} from "../shared/transforms.ts";
import { Input } from "./Input.tsx";
import { pageStyles } from "./pageStyles.ts";
import type { Editor } from "./RecordList.tsx";
import { styles as settingsStyles } from "./settingsParts.tsx";
import type { KeyboardLayout } from "./shortcutCapture.ts";
import { ShortcutPicker } from "./ShortcutPicker.tsx";
import { surfaces } from "./surfaces.ts";
import { color, font, leading, space, text } from "./tokens.stylex.ts";

const styles = stylex.create({
  field: { display: "flex", flexDirection: "column", gap: space.xs },
  head: { display: "flex", alignItems: "baseline", justifyContent: "space-between" },
  counter: {
    color: color.mutedForeground,
    fontSize: text.xxs,
    fontWeight: 500,
    fontVariantNumeric: "tabular-nums",
    lineHeight: leading.xxs,
  },
  // Adapted textarea (MIT, see THIRD_PARTY_NOTICES.md): grows with its text up to a cap.
  textareaFrame: { display: "flex", width: "100%" },
  textarea: {
    width: "100%",
    minHeight: 140,
    maxHeight: 256,
    paddingBlock: 5,
    paddingInline: 11,
    borderWidth: 0,
    borderRadius: "inherit",
    backgroundColor: "transparent",
    color: color.foreground,
    fontFamily: font.sans,
    fontSize: text.sm,
    lineHeight: leading.sm,
    overflowWrap: "anywhere",
    fieldSizing: "content",
    resize: "none",
    outline: "none",
    "::placeholder": { color: color.mutedForeground },
  },
});

export function TransformFields({
  editor: { draft, edit, shown, message, saveOnEnter },
  others,
  layout,
  dictationKeys,
}: {
  editor: Editor<Transform, TransformProblem["field"]>;
  others: readonly ShortcutHolder[];
  layout: KeyboardLayout | null;
  dictationKeys: readonly Hotkey[];
}) {
  return (
    <>
      <CountedField
        label="Name"
        length={draft.name.length}
        max={TRANSFORM_NAME_MAX_LENGTH}
        problem={message("name")}
      >
        <Input
          value={draft.name}
          maxLength={TRANSFORM_NAME_MAX_LENGTH}
          autoComplete="off"
          placeholder="Bulleted list"
          invalid={shown?.field === "name"}
          onChange={(event) => edit({ name: event.currentTarget.value })}
          onKeyDown={saveOnEnter}
        />
      </CountedField>
      <CountedField
        label="Instruction"
        length={draft.instruction.length}
        max={INSTRUCTION_MAX_LENGTH}
        problem={message("instruction")}
      >
        <span
          {...stylex.props(
            surfaces.control,
            surfaces.field,
            shown?.field === "instruction" && surfaces.fieldInvalid,
            styles.textareaFrame,
          )}
        >
          <Field.Control
            render={<textarea />}
            value={draft.instruction}
            maxLength={INSTRUCTION_MAX_LENGTH}
            placeholder="Turn this text into a short bulleted list."
            onValueChange={(instruction) => edit({ instruction })}
            {...stylex.props(styles.textarea)}
          />
        </span>
      </CountedField>
      <ShortcutPicker
        value={draft.shortcut}
        others={others}
        layout={layout}
        dictationKeys={dictationKeys}
        invalid={shown?.field === "shortcut"}
        onChange={(shortcut) => edit({ shortcut })}
      />
      {message("shortcut") && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {message("shortcut")}
        </p>
      )}
    </>
  );
}

// A labelled field with a live character counter in caption type.
function CountedField({
  label,
  length,
  max,
  problem,
  children,
}: {
  label: string;
  length: number;
  max: number;
  problem: string | undefined;
  children: ReactNode;
}) {
  return (
    <Field.Root invalid={problem !== undefined} {...stylex.props(styles.field)}>
      <div {...stylex.props(styles.head)}>
        <Field.Label {...stylex.props(settingsStyles.rowTitle)}>{label}</Field.Label>
        <Field.Description {...stylex.props(styles.counter)}>
          {length}/{max}
        </Field.Description>
      </div>
      {children}
      {problem !== undefined && (
        <Field.Error match {...stylex.props(pageStyles.error)}>
          {problem}
        </Field.Error>
      )}
    </Field.Root>
  );
}

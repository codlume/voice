import { Field } from "@base-ui/react/field";
import * as stylex from "@stylexjs/stylex";

import type { Hotkey } from "../shared/api.ts";
import {
  INSTRUCTION_MAX_LENGTH,
  TRANSFORM_NAME_MAX_LENGTH,
  type Transform,
  type TransformProblem,
} from "../shared/transforms.ts";
import { pageStyles } from "./pageStyles.ts";
import { CountedField, styles as form, type Editor } from "./RecordList.tsx";
import type { KeyboardLayout } from "./shortcutCapture.ts";
import { ShortcutPicker } from "./ShortcutPicker.tsx";

const styles = stylex.create({
  instruction: { minHeight: 140, resize: "vertical", lineHeight: 1.45 },
});

/** Name, instruction and shortcut, inside the transform editor. */
export function TransformFields({
  editor: { draft, edit, shown, message, saveOnEnter },
  others,
  layout,
  dictationKeys,
}: {
  editor: Editor<Transform, TransformProblem["field"]>;
  others: readonly Transform[];
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
        <Field.Control
          value={draft.name}
          maxLength={TRANSFORM_NAME_MAX_LENGTH}
          autoComplete="off"
          placeholder="Bulleted list"
          onValueChange={(name) => edit({ name })}
          onKeyDown={saveOnEnter}
          {...stylex.props(form.input, shown?.field === "name" && form.invalid)}
        />
      </CountedField>
      <CountedField
        label="Instruction"
        length={draft.instruction.length}
        max={INSTRUCTION_MAX_LENGTH}
        problem={message("instruction")}
      >
        <Field.Control
          render={<textarea />}
          value={draft.instruction}
          maxLength={INSTRUCTION_MAX_LENGTH}
          placeholder="Turn this text into a short bulleted list."
          onValueChange={(instruction) => edit({ instruction })}
          {...stylex.props(
            form.input,
            styles.instruction,
            shown?.field === "instruction" && form.invalid,
          )}
        />
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

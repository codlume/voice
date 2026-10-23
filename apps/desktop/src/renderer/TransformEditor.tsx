import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";

import type { Hotkey } from "../shared/api.ts";
import {
  INSTRUCTION_MAX_LENGTH,
  TRANSFORM_NAME_MAX_LENGTH,
  transformProblem,
  type Transform,
} from "../shared/transforms.ts";
import { Button } from "./Button.tsx";
import { DialogFrame } from "./ConfirmDialog.tsx";
import { pageStyles } from "./pageStyles.ts";
import { CountedField, styles as form } from "./RecordList.tsx";
import type { KeyboardLayout } from "./shortcutCapture.ts";
import { ShortcutPicker } from "./ShortcutPicker.tsx";
import { useAction } from "./useAction.ts";

const styles = stylex.create({
  instruction: { minHeight: 140, resize: "vertical", lineHeight: 1.45 },
});

export type EditorMode = "create" | "edit";

const COPY: Record<EditorMode, { title: string; save: string }> = {
  create: { title: "Create transform", save: "Create transform" },
  edit: { title: "Edit transform", save: "Save changes" },
};

const normalize = (draft: Transform): Transform => ({
  ...draft,
  name: draft.name.trim(),
  instruction: draft.instruction.trim(),
});

/** Name, instruction and shortcut, with Delete for a transform that exists. */
export function TransformEditor({
  mode,
  initial,
  items,
  layout,
  dictationKeys,
  save,
  onDelete,
  open,
  onOpenChange,
  onOpenChangeComplete,
}: {
  mode: EditorMode;
  initial: Transform;
  items: readonly Transform[];
  layout: KeyboardLayout | null;
  dictationKeys: readonly Hotkey[];
  save: (next: readonly Transform[]) => Promise<void>;
  onDelete: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
}) {
  const fieldsRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(initial);
  const [failedSaves, setFailedSaves] = useState(0);
  const { pending, error, run, clearError } = useAction();
  const transform = normalize(draft);
  const others = items.filter((other) => other.id !== transform.id);
  const current = transformProblem(transform, others);
  const shown = failedSaves > 0 ? current : null;
  const message = (field: NonNullable<typeof current>["field"]) =>
    shown?.field === field ? shown.message : undefined;
  const edit = (patch: Partial<Transform>) => {
    clearError();
    setDraft((previous) => ({ ...previous, ...patch }));
  };

  useEffect(() => {
    if (failedSaves === 0) return;
    fieldsRef.current
      ?.querySelector<HTMLElement>("input[data-invalid], textarea[data-invalid], [aria-invalid]")
      ?.focus();
  }, [failedSaves]);

  function submit() {
    if (pending) return;
    if (current) {
      setFailedSaves((count) => count + 1);
      return;
    }
    const next =
      mode === "create"
        ? [...items, transform]
        : items.map((other) => (other.id === transform.id ? transform : other));
    void run(async () => {
      await save(next);
      onOpenChange(false);
    }, "Could not save this transform. Try again.");
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
      disablePointerDismissal
    >
      <DialogFrame
        title={COPY[mode].title}
        wide
        footerStart={
          mode === "edit" && (
            <Button variant="text" onClick={onDelete}>
              Delete transform
            </Button>
          )
        }
        actions={
          <Button disabled={pending} onClick={submit}>
            {COPY[mode].save}
          </Button>
        }
      >
        <div ref={fieldsRef} {...stylex.props(form.fields)}>
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
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) submit();
              }}
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
        </div>
        {error && (
          <p role="alert" {...stylex.props(pageStyles.error, form.saveError)}>
            {error}
          </p>
        )}
      </DialogFrame>
    </Dialog.Root>
  );
}

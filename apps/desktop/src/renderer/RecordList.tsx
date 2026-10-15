import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import * as stylex from "@stylexjs/stylex";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { ConfirmDialog, DialogFrame } from "./ConfirmDialog.tsx";
import { styles as settings } from "./Settings.tsx";
import { color, radius, space } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";

export const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.lg },
  header: { display: "flex", alignItems: "flex-start", gap: space.lg },
  headerText: { display: "flex", flexDirection: "column", gap: space.sm, flexGrow: 1 },
  subtitle: { margin: 0, color: color.mutedForeground },
  list: { margin: 0, padding: 0, listStyle: "none" },
  rowText: { display: "flex", flexDirection: "column", gap: 2 },
  wrap: { overflowWrap: "anywhere" },
  detail: {
    display: "-webkit-box",
    overflow: "hidden",
    whiteSpace: "pre-wrap",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
  },
  example: { color: color.mutedForeground },
  off: { opacity: 0.6 },
  rowActions: { display: "flex", flexShrink: 0, alignItems: "center", gap: 4 },
  fields: { display: "flex", flexDirection: "column", gap: space.md, marginTop: space.lg },
  field: { display: "flex", flexDirection: "column", gap: 6 },
  fieldHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between" },
  counter: { fontVariantNumeric: "tabular-nums" },
  input: {
    width: "100%",
    paddingBlock: 6,
    paddingInline: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: color.border, ":focus": color.input },
    borderRadius: radius.medium,
    backgroundColor: color.card,
    color: color.foreground,
    font: "inherit",
    fontSize: 13,
  },
  invalid: { borderColor: { default: color.error, ":focus": color.error } },
  saveError: { marginTop: space.md },
});

type Mode = "add" | "edit";

export type Problem<F extends string> = { field: F; message: string };

// Only one dialog can be open. The record outlives `open` so the dialog keeps its content through
// the exit animation. `key` is new on every open, so the next add or edit, even of the same
// record, starts from the saved values instead of the closing dialog's draft. "deleted" is the
// delete dialog after its confirm, when the row it would return focus to is going away.
type Modal<T> = { kind: Mode | "delete" | "deleted"; record: T; open: boolean; key: string };

export type Copy = {
  title: string;
  subtitle: string;
  hint: string;
  deleteTitle: string;
  editor: Record<Mode, { title: string; save: string }>;
  saveFailed: string;
  deleteFailed: string;
};

type RowText = { title: string; detail?: string; faded?: boolean };

/** What the editor dialog hands the page to render its fields. */
export type Editor<T, F extends string> = {
  draft: T;
  edit: (patch: Partial<T>) => void;
  // The problem to show, once a save was attempted.
  shown: Problem<F> | null;
  message: (field: F) => string | undefined;
  submit: () => void;
  saveOnEnter: (event: KeyboardEvent) => void;
};

/** A settings page that lists records with Edit and Delete, an add/edit dialog, and a delete confirm. */
export function RecordList<T extends { id: string }, F extends string>({
  copy,
  records,
  save,
  blank,
  name,
  example,
  row,
  renderControls,
  normalize,
  problem,
  renderFields,
  wide = false,
}: {
  copy: Copy;
  records: readonly T[];
  save: (next: readonly T[]) => Promise<void>;
  blank: () => T;
  // Names a record in `Edit <name>`, `Delete <name>`, and the delete confirmation.
  name: (record: T) => string;
  // The one row shown while the list is empty.
  example: RowText;
  row: (record: T) => RowText;
  // Extra controls before Edit and Delete. `change` saves a list unless a row action is pending.
  renderControls?: (record: T, change: (next: readonly T[], failure: string) => void) => ReactNode;
  // The record as saved, from the draft: trimmed, with empty optional fields normalised.
  normalize: (draft: T) => T;
  // `others` never contains the record being checked.
  problem: (record: T, others: readonly T[]) => Problem<F> | null;
  renderFields: (editor: Editor<T, F>) => ReactNode;
  wide?: boolean;
}) {
  const [modal, setModal] = useState<Modal<T> | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const rowAction = useAction();

  const show = (kind: Modal<T>["kind"], record: T) =>
    setModal({ kind, record, open: true, key: crypto.randomUUID() });
  const setOpen = (open: boolean) => setModal((current) => current && { ...current, open });
  const clearOnClose = (open: boolean) => {
    if (!open) setModal(null);
  };

  const change = (next: readonly T[], failure: string) => {
    // Each save replaces the whole list, so a change built on the list before the previous save
    // landed would undo that save.
    if (rowAction.pending) return;
    void rowAction.run(() => save(next), failure);
  };

  const remove = (record: T) => {
    setModal((current) => current && { ...current, kind: "deleted" });
    void rowAction.run(
      () => save(records.filter((other) => other.id !== record.id)),
      copy.deleteFailed,
    );
  };

  const text = ({ title, detail, faded }: RowText, isExample = false) => (
    <div {...stylex.props(settings.rowText, styles.rowText, faded && styles.off)}>
      <span {...stylex.props(settings.rowTitle, isExample ? styles.example : styles.wrap)}>
        {title}
      </span>
      {detail !== undefined && (
        <p
          {...stylex.props(
            settings.rowDetail,
            !isExample && styles.wrap,
            !isExample && styles.detail,
          )}
        >
          {detail}
        </p>
      )}
    </div>
  );

  return (
    <div {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.headerText)}>
          <h1 {...stylex.props(settings.headline)}>{copy.title}</h1>
          <p {...stylex.props(styles.subtitle)}>{copy.subtitle}</p>
        </div>
        <Button ref={addRef} onClick={() => show("add", blank())}>
          Add new
        </Button>
      </header>

      <Card>
        {records.length === 0 ? (
          <div {...stylex.props(settings.row)}>
            {text(example, true)}
            <span {...stylex.props(settings.hint)}>Example</span>
          </div>
        ) : (
          <ul {...stylex.props(styles.list)}>
            {records.map((record) => (
              <li key={record.id} {...stylex.props(settings.row)}>
                {text(row(record))}
                <div {...stylex.props(styles.rowActions)}>
                  {renderControls?.(record, change)}
                  <Button
                    variant="icon"
                    aria-label={`Edit ${name(record)}`}
                    title="Edit"
                    onClick={() => show("edit", record)}
                  >
                    <PencilIcon size={16} />
                  </Button>
                  <Button
                    variant="icon"
                    aria-label={`Delete ${name(record)}`}
                    title="Delete"
                    onClick={() => show("delete", record)}
                  >
                    <Trash2Icon size={16} />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p {...stylex.props(settings.hint)}>{copy.hint}</p>
      {rowAction.error && (
        <p role="alert" {...stylex.props(settings.error)}>
          {rowAction.error}
        </p>
      )}

      {(modal?.kind === "add" || modal?.kind === "edit") && (
        <RecordEditor
          key={modal.key}
          open={modal.open}
          onOpenChange={setOpen}
          onOpenChangeComplete={clearOnClose}
          mode={modal.kind}
          initial={modal.record}
          records={records}
          copy={copy}
          save={save}
          normalize={normalize}
          problem={problem}
          renderFields={renderFields}
          wide={wide}
        />
      )}
      {(modal?.kind === "delete" || modal?.kind === "deleted") && (
        <ConfirmDialog
          open={modal.open}
          onOpenChange={setOpen}
          onOpenChangeComplete={clearOnClose}
          // The deleted row's trash button leaves the DOM, so focus would otherwise fall to <body>.
          finalFocus={modal.kind === "deleted" ? addRef : undefined}
          title={copy.deleteTitle}
          description={`‘${name(modal.record)}’ will be deleted permanently.`}
          actions={[
            { label: "Delete", variant: "destructive", onClick: () => remove(modal.record) },
          ]}
        />
      )}
    </div>
  );
}

function RecordEditor<T extends { id: string }, F extends string>({
  mode,
  initial,
  records,
  copy,
  save,
  normalize,
  problem,
  renderFields,
  wide,
  open,
  onOpenChange,
  onOpenChangeComplete,
}: {
  mode: Mode;
  initial: T;
  records: readonly T[];
  copy: Copy;
  save: (next: readonly T[]) => Promise<void>;
  normalize: (draft: T) => T;
  problem: (record: T, others: readonly T[]) => Problem<F> | null;
  renderFields: (editor: Editor<T, F>) => ReactNode;
  wide: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
}) {
  const fieldsRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(initial);
  const [failedSaves, setFailedSaves] = useState(0);
  const { pending, error, run, clearError } = useAction();
  const text = copy.editor[mode];
  const record = normalize(draft);
  const current = problem(
    record,
    records.filter((other) => other.id !== record.id),
  );
  const shown = failedSaves > 0 ? current : null;

  // Each failed save focuses the control of the field with the problem. Base UI marks the control
  // of an invalid Field.Root with data-invalid.
  useEffect(() => {
    if (failedSaves === 0) return;
    fieldsRef.current
      ?.querySelector<HTMLElement>("input[data-invalid], [contenteditable][data-invalid]")
      ?.focus();
  }, [failedSaves]);

  function submit() {
    if (pending) return;
    if (current) {
      setFailedSaves((count) => count + 1);
      return;
    }
    const next =
      mode === "add"
        ? [...records, record]
        : records.map((other) => (other.id === record.id ? record : other));
    void run(async () => {
      await save(next);
      onOpenChange(false);
    }, copy.saveFailed);
  }

  const editor: Editor<T, F> = {
    draft,
    edit: (patch) => {
      clearError();
      setDraft((previous) => ({ ...previous, ...patch }));
    },
    shown,
    message: (field) => (shown?.field === field ? shown.message : undefined),
    submit,
    saveOnEnter: (event) => {
      if (event.key === "Enter" && !event.nativeEvent.isComposing) submit();
    },
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
      disablePointerDismissal
    >
      <DialogFrame
        title={text.title}
        wide={wide}
        actions={
          <Button disabled={pending} onClick={submit}>
            {text.save}
          </Button>
        }
      >
        <div ref={fieldsRef} {...stylex.props(styles.fields)}>
          {renderFields(editor)}
        </div>
        {error && (
          <p role="alert" {...stylex.props(settings.error, styles.saveError)}>
            {error}
          </p>
        )}
      </DialogFrame>
    </Dialog.Root>
  );
}

/** A labelled field with an n/max counter and the problem shown under it. */
export function CountedField({
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
      <div {...stylex.props(styles.fieldHead)}>
        <Field.Label {...stylex.props(settings.sectionLabel)}>{label}</Field.Label>
        <Field.Description {...stylex.props(settings.hint, styles.counter)}>
          {length}/{max}
        </Field.Description>
      </div>
      {children}
      {problem !== undefined && (
        <Field.Error match {...stylex.props(settings.error)}>
          {problem}
        </Field.Error>
      )}
    </Field.Root>
  );
}

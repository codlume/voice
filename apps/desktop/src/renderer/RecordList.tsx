import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import * as stylex from "@stylexjs/stylex";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { ConfirmDialog, DialogFrame } from "./ConfirmDialog.tsx";
import { useHoldNavigation } from "./navigationHold.ts";
import { pageStyles } from "./pageStyles.ts";
import { styles as settings } from "./settingsParts.tsx";
import { color, leading, motion, radius, space, text as size } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";

export const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.lg },
  header: { display: "flex", flexDirection: "column", gap: space.sm },
  // The page's one action sits on the headline's baseline.
  titleRow: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.lg,
  },
  subtitle: { margin: 0, color: color.mutedForeground },
  // Adapted list row (MIT, see THIRD_PARTY_NOTICES.md): hairline-divided rows that tint on hover,
  // clipped to the card's corners.
  list: {
    margin: 0,
    padding: 0,
    overflow: "hidden",
    borderRadius: `calc(${radius.large} - 1px)`,
    listStyle: "none",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.base,
    minHeight: 44,
    paddingBlock: space.md,
    paddingInline: space.base,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: `color-mix(in srgb, ${color.border} 50%, transparent)`,
    backgroundColor: { default: "transparent", ":hover": color.accent },
    transitionProperty: "background-color",
    transitionDuration: { default: motion.fast, [motion.reduced]: "0s" },
  },
  rowText: { display: "flex", flexDirection: "column", gap: 2, flexGrow: 1, minWidth: 0 },
  wrap: { overflowWrap: "anywhere" },
  detail: {
    display: "-webkit-box",
    overflow: "hidden",
    whiteSpace: "pre-wrap",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
  },
  example: { color: color.mutedForeground },
  off: { opacity: 0.64 },
  trailing: { display: "flex", flexShrink: 0, alignItems: "center", gap: space.sm },
  // Edit and delete keep their place but show only while the row is hovered or holds keyboard
  // focus, so the list reads as content rather than a column of icons.
  rowActions: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover")]: 1,
      [stylex.when.ancestor(":focus-within")]: 1,
    },
    transitionProperty: "opacity",
    transitionDuration: { default: motion.fast, [motion.reduced]: "0s" },
  },
  fields: { display: "flex", flexDirection: "column", gap: space.base },
  field: { display: "flex", flexDirection: "column", gap: space.xs },
  fieldHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between" },
  counter: {
    color: color.mutedForeground,
    fontSize: size.xxs,
    fontWeight: 500,
    fontVariantNumeric: "tabular-nums",
    lineHeight: leading.xxs,
  },
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
  // The focus outline sits over the border, so an invalid field draws it in the error color too.
  invalid: { borderColor: color.error, outlineColor: color.error },
  saveError: { marginTop: space.md },
});

export type Mode = "add" | "edit";

type Problem<F extends string> = { field: F; message: string };

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

type RowText = {
  title: string;
  detail?: string;
  off?: boolean;
};

export type Editor<T, F extends string> = {
  draft: T;
  edit: (patch: Partial<T>) => void;
  shown: Problem<F> | null;
  message: (field: F) => string | undefined;
  submit: () => void;
  saveOnEnter: (event: KeyboardEvent) => void;
};

export function RecordList<T extends { id: string }, F extends string>({
  copy,
  records,
  save,
  blank,
  name,
  example,
  row,
  normalize,
  problem,
  renderFields,
  renderFooter,
  wide = false,
}: {
  copy: Copy;
  records: readonly T[];
  save: (next: readonly T[]) => Promise<void>;
  blank: () => T;
  name: (record: T) => string;
  example: RowText;
  row: (record: T) => RowText;
  // The record as saved, from the draft: trimmed, with empty optional fields normalised.
  normalize: (draft: T) => T;
  // `others` never contains the record being checked.
  problem: (record: T, others: readonly T[]) => Problem<F> | null;
  renderFields: (editor: Editor<T, F>) => ReactNode;
  renderFooter?: (editor: Editor<T, F>) => ReactNode;
  wide?: boolean;
}) {
  const [modal, setModal] = useState<Modal<T> | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const baseId = useId();
  const rowAction = useAction();

  const show = (kind: Modal<T>["kind"], record: T) =>
    setModal({ kind, record, open: true, key: crypto.randomUUID() });
  const setOpen = (open: boolean) => setModal((current) => current && { ...current, open });
  const clearOnClose = (open: boolean) => {
    if (!open) setModal(null);
  };

  const remove = (record: T) => {
    setModal((current) => current && { ...current, kind: "deleted" });
    void rowAction.run(
      () => save(records.filter((other) => other.id !== record.id)),
      copy.deleteFailed,
    );
  };

  const text = ({ title, detail, off }: RowText, isExample = false) => (
    <div {...stylex.props(settings.rowText, styles.rowText, off && styles.off)}>
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
        <div {...stylex.props(styles.titleRow)}>
          <h1 {...stylex.props(pageStyles.headline)}>{copy.title}</h1>
          <Button ref={addRef} onClick={() => show("add", blank())}>
            <PlusIcon size={16} aria-hidden />
            Add new
          </Button>
        </div>
        <p {...stylex.props(styles.subtitle)}>{copy.subtitle}</p>
      </header>

      <Card>
        {records.length === 0 ? (
          <div {...stylex.props(settings.row)}>
            {text(example, true)}
            <span {...stylex.props(settings.hint)}>Example</span>
          </div>
        ) : (
          <ul {...stylex.props(styles.list)}>
            {records.map((record) => {
              const rowText = row(record);
              const offId = `${baseId}-${record.id}-off`;
              return (
                <li key={record.id} {...stylex.props(stylex.defaultMarker(), styles.row)}>
                  {text(rowText)}
                  <div {...stylex.props(styles.trailing)}>
                    {rowText.off && (
                      <span id={offId}>
                        <Badge>Off</Badge>
                      </span>
                    )}
                    <div {...stylex.props(styles.rowActions)}>
                      <Button
                        variant="icon"
                        aria-label={`Edit ${name(record)}`}
                        aria-describedby={rowText.off ? offId : undefined}
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
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <p {...stylex.props(settings.hint)}>{copy.hint}</p>
      {rowAction.error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
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
          renderFooter={renderFooter}
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

export function RecordEditor<T extends { id: string }, F extends string>({
  mode,
  initial,
  records,
  copy,
  save,
  normalize,
  problem,
  renderFields,
  renderFooter,
  wide,
  finalFocus,
  open,
  onOpenChange,
  onOpenChangeComplete,
}: {
  mode: Mode;
  initial: T;
  records: readonly T[];
  copy: Pick<Copy, "editor" | "saveFailed">;
  save: (next: readonly T[]) => Promise<void>;
  normalize: (draft: T) => T;
  problem: (record: T, others: readonly T[]) => Problem<F> | null;
  renderFields: (editor: Editor<T, F>) => ReactNode;
  renderFooter: ((editor: Editor<T, F>) => ReactNode) | undefined;
  wide: boolean;
  finalFocus?: RefObject<HTMLElement | null> | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
}) {
  const fieldsRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(initial);
  const [failedSaves, setFailedSaves] = useState(0);
  const { pending, error, run, clearError } = useAction();
  useHoldNavigation(open);
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
      ?.querySelector<HTMLElement>(
        'input[data-invalid], textarea[data-invalid], [contenteditable][data-invalid], [aria-invalid="true"]',
      )
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
        finalFocus={finalFocus}
        footerStart={renderFooter?.(editor)}
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
          <p role="alert" {...stylex.props(pageStyles.error, styles.saveError)}>
            {error}
          </p>
        )}
      </DialogFrame>
    </Dialog.Root>
  );
}

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
        <Field.Label {...stylex.props(settings.rowTitle)}>{label}</Field.Label>
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

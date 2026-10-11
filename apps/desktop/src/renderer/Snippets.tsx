import { Dialog } from "@base-ui/react/dialog";
import * as stylex from "@stylexjs/stylex";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";

import {
  EXPANSION_MAX_LENGTH,
  snippetProblem,
  TRIGGER_MAX_LENGTH,
  type Snippet,
} from "../shared/snippets.ts";
import { Button } from "./Button.tsx";
import { ConfirmDialog, styles as dialog } from "./ConfirmDialog.tsx";
import { styles as settings } from "./Settings.tsx";
import { titlebar } from "./titlebar.ts";
import { color, radius, space } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.lg },
  header: { display: "flex", alignItems: "flex-start", gap: space.lg },
  headerText: { display: "flex", flexDirection: "column", gap: space.sm, flexGrow: 1 },
  subtitle: { margin: 0, color: color.mutedForeground },
  list: { margin: 0, padding: 0, listStyle: "none" },
  rowText: { display: "flex", flexDirection: "column", gap: 2 },
  wrap: { overflowWrap: "anywhere" },
  expansion: {
    display: "-webkit-box",
    overflow: "hidden",
    whiteSpace: "pre-wrap",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
  },
  example: { color: color.mutedForeground },
  rowActions: { display: "flex", flexShrink: 0, gap: 4 },
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
  textarea: { minHeight: 120, lineHeight: 1.45, resize: "vertical" },
  invalid: { borderColor: { default: color.error, ":focus": color.error } },
  saveError: { marginTop: space.md },
});

type Mode = "add" | "edit";
type Editing = { open: boolean; mode: Mode; snippet: Snippet };
type Deleting = { open: boolean; snippet: Snippet };

const editorText: Record<Mode, { title: string; save: string }> = {
  add: { title: "Add snippet", save: "Add snippet" },
  edit: { title: "Edit snippet", save: "Save changes" },
};

export function Snippets({ snippets }: { snippets: readonly Snippet[] }) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const deleteAction = useAction();

  const remove = (snippet: Snippet) =>
    void deleteAction.run(
      () =>
        window.voice.updateSettings({
          snippets: snippets.filter((other) => other.id !== snippet.id),
        }),
      "Could not delete this snippet. Try again.",
    );

  return (
    <div {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.headerText)}>
          <h1 {...stylex.props(settings.headline)}>Snippets</h1>
          <p {...stylex.props(styles.subtitle)}>
            Say a short phrase and Voice types the saved text, anywhere you dictate.
          </p>
        </div>
        <Button
          onClick={() =>
            setEditing({
              open: true,
              mode: "add",
              snippet: { id: crypto.randomUUID(), trigger: "", expansion: "" },
            })
          }
        >
          Add new
        </Button>
      </header>

      <div {...stylex.props(settings.card)}>
        {snippets.length === 0 ? (
          <div {...stylex.props(settings.row)}>
            <div {...stylex.props(settings.rowText, styles.rowText)}>
              <span {...stylex.props(settings.rowTitle, styles.example)}>my email</span>
              <p {...stylex.props(settings.rowDetail)}>name@example.com</p>
            </div>
            <span {...stylex.props(settings.hint)}>Example</span>
          </div>
        ) : (
          <ul {...stylex.props(styles.list)}>
            {snippets.map((snippet) => (
              <li key={snippet.id} {...stylex.props(settings.row)}>
                <div {...stylex.props(settings.rowText, styles.rowText)}>
                  <span {...stylex.props(settings.rowTitle, styles.wrap)}>{snippet.trigger}</span>
                  <p {...stylex.props(settings.rowDetail, styles.wrap, styles.expansion)}>
                    {snippet.expansion}
                  </p>
                </div>
                <div {...stylex.props(styles.rowActions)}>
                  <button
                    type="button"
                    aria-label={`Edit ${snippet.trigger}`}
                    title="Edit"
                    onClick={() => setEditing({ open: true, mode: "edit", snippet })}
                    {...stylex.props(titlebar.button)}
                  >
                    <PencilIcon size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${snippet.trigger}`}
                    title="Delete"
                    onClick={() => setDeleting({ open: true, snippet })}
                    {...stylex.props(titlebar.button)}
                  >
                    <Trash2Icon size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p {...stylex.props(settings.hint)}>
        Snippets type exactly what you saved. Cleanup never changes them.
      </p>
      {deleteAction.error && (
        <p role="alert" {...stylex.props(settings.error)}>
          {deleteAction.error}
        </p>
      )}

      {editing && (
        <SnippetDialog
          editing={editing}
          snippets={snippets}
          onOpenChange={(open) => setEditing((current) => current && { ...current, open })}
          onClosed={() => setEditing(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          open={deleting.open}
          onOpenChange={(open) => setDeleting({ ...deleting, open })}
          title="Delete snippet?"
          description={`‘${deleting.snippet.trigger}’ will be deleted permanently.`}
          actions={[
            { label: "Delete", variant: "destructive", onClick: () => remove(deleting.snippet) },
          ]}
        />
      )}
    </div>
  );
}

function SnippetDialog({
  editing,
  snippets,
  onOpenChange,
  onClosed,
}: {
  editing: Editing;
  snippets: readonly Snippet[];
  onOpenChange: (open: boolean) => void;
  onClosed: () => void;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLInputElement>(null);
  const expansionRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(editing.snippet);
  const [saveAttempted, setSaveAttempted] = useState(false);
  const { pending, error, run, clearError } = useAction();
  const text = editorText[editing.mode];
  const snippet = { ...draft, trigger: draft.trigger.trim() };
  const problem = saveAttempted ? snippetProblem(snippet, snippets) : null;
  const triggerProblem = problem?.field === "trigger" ? problem.message : "";
  const expansionProblem = problem?.field === "expansion" ? problem.message : "";
  const triggerId = `${id}-trigger`;
  const expansionId = `${id}-expansion`;

  const edit = (patch: Partial<Snippet>) => {
    clearError();
    setDraft({ ...draft, ...patch });
  };

  function save() {
    if (pending) return;
    const found = snippetProblem(snippet, snippets);
    if (found) {
      setSaveAttempted(true);
      (found.field === "trigger" ? triggerRef : expansionRef).current?.focus();
      return;
    }
    const next =
      editing.mode === "add"
        ? [...snippets, snippet]
        : snippets.map((other) => (other.id === snippet.id ? snippet : other));
    void run(async () => {
      await window.voice.updateSettings({ snippets: next });
      onOpenChange(false);
    }, "Could not save this snippet. Try again.");
  }

  return (
    <Dialog.Root
      open={editing.open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(open) => !open && onClosed()}
      disablePointerDismissal
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          className={({ transitionStatus }) =>
            stylex.props(
              dialog.backdrop,
              (transitionStatus === "starting" || transitionStatus === "ending") &&
                dialog.backdropHidden,
            ).className
          }
        />
        <Dialog.Popup
          className={({ transitionStatus }) =>
            stylex.props(
              dialog.popup,
              (transitionStatus === "starting" || transitionStatus === "ending") &&
                dialog.popupHidden,
            ).className
          }
        >
          <Dialog.Title {...stylex.props(dialog.title)}>{text.title}</Dialog.Title>
          <div {...stylex.props(styles.fields)}>
            <Field
              id={triggerId}
              label="Trigger"
              length={draft.trigger.length}
              max={TRIGGER_MAX_LENGTH}
              problem={triggerProblem}
            >
              <input
                ref={triggerRef}
                id={triggerId}
                value={draft.trigger}
                maxLength={TRIGGER_MAX_LENGTH}
                autoComplete="off"
                spellCheck={false}
                placeholder="my email"
                {...fieldAria(triggerId, triggerProblem)}
                onChange={(event) => edit({ trigger: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) save();
                }}
                {...stylex.props(styles.input, triggerProblem !== "" && styles.invalid)}
              />
            </Field>
            <Field
              id={expansionId}
              label="Expansion"
              length={draft.expansion.length}
              max={EXPANSION_MAX_LENGTH}
              problem={expansionProblem}
            >
              <textarea
                ref={expansionRef}
                id={expansionId}
                value={draft.expansion}
                maxLength={EXPANSION_MAX_LENGTH}
                spellCheck={false}
                placeholder="name@example.com"
                {...fieldAria(expansionId, expansionProblem)}
                onChange={(event) => edit({ expansion: event.target.value })}
                {...stylex.props(
                  styles.input,
                  styles.textarea,
                  expansionProblem !== "" && styles.invalid,
                )}
              />
            </Field>
          </div>
          {error && (
            <p role="alert" {...stylex.props(settings.error, styles.saveError)}>
              {error}
            </p>
          )}
          <div {...stylex.props(dialog.actions)}>
            <Dialog.Close render={<Button variant="secondary" />}>Cancel</Dialog.Close>
            <Button disabled={pending} onClick={save}>
              {text.save}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function fieldAria(id: string, problem: string) {
  return {
    "aria-invalid": problem !== "",
    "aria-describedby": problem ? `${id}-count ${id}-error` : `${id}-count`,
  };
}

function Field({
  id,
  label,
  length,
  max,
  problem,
  children,
}: {
  id: string;
  label: string;
  length: number;
  max: number;
  problem: string;
  children: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.field)}>
      <div {...stylex.props(styles.fieldHead)}>
        <label htmlFor={id} {...stylex.props(settings.sectionLabel)}>
          {label}
        </label>
        <span id={`${id}-count`} {...stylex.props(settings.hint, styles.counter)}>
          {length}/{max}
        </span>
      </div>
      {children}
      {problem && (
        <p id={`${id}-error`} {...stylex.props(settings.error)}>
          {problem}
        </p>
      )}
    </div>
  );
}

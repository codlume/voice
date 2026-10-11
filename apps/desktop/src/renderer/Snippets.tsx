import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import * as stylex from "@stylexjs/stylex";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import {
  EXPANSION_MAX_LENGTH,
  snippetProblem,
  TRIGGER_MAX_LENGTH,
  type Snippet,
  type SnippetProblem,
} from "../shared/snippets.ts";
import { Button } from "./Button.tsx";
import { ConfirmDialog, DialogFrame } from "./ConfirmDialog.tsx";
import { styles as settings } from "./Settings.tsx";
import { Switch } from "./Switch.tsx";
import { color, radius, space } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";

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
  textarea: { minHeight: 120, lineHeight: 1.45, resize: "vertical" },
  invalid: { borderColor: { default: color.error, ":focus": color.error } },
  saveError: { marginTop: space.md },
});

type Mode = "add" | "edit";
// Only one dialog can be open. The record outlives `open` so the dialog keeps its content through
// the exit animation, then clears so the next add or edit starts from a fresh draft. "deleted" is
// the delete dialog after its confirm, when the row it would return focus to is going away.
type Modal = { kind: Mode | "delete" | "deleted"; snippet: Snippet; open: boolean };

const editorText: Record<Mode, { title: string; save: string }> = {
  add: { title: "Add snippet", save: "Add snippet" },
  edit: { title: "Edit snippet", save: "Save changes" },
};

export function Snippets({ snippets }: { snippets: readonly Snippet[] }) {
  const [modal, setModal] = useState<Modal | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const rowAction = useAction();

  const show = (kind: Modal["kind"], snippet: Snippet) => setModal({ kind, snippet, open: true });
  const setOpen = (open: boolean) => setModal((current) => current && { ...current, open });
  const clearOnClose = (open: boolean) => {
    if (!open) setModal(null);
  };

  const remove = (snippet: Snippet) => {
    setModal((current) => current && { ...current, kind: "deleted" });
    void rowAction.run(
      () =>
        hubApi().updateSettings({
          snippets: snippets.filter((other) => other.id !== snippet.id),
        }),
      "Could not delete this snippet. Try again.",
    );
  };

  const setEnabled = (snippet: Snippet, enabled: boolean) => {
    // Each save replaces the whole list, so a toggle built on the list before the previous save
    // landed would undo that save.
    if (rowAction.pending) return;
    void rowAction.run(
      () =>
        hubApi().updateSettings({
          snippets: snippets.map((other) =>
            other.id === snippet.id ? { ...other, enabled } : other,
          ),
        }),
      "Could not change this snippet. Try again.",
    );
  };

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
          ref={addRef}
          onClick={() =>
            show("add", { id: crypto.randomUUID(), trigger: "", expansion: "", enabled: true })
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
                <div
                  {...stylex.props(
                    settings.rowText,
                    styles.rowText,
                    !snippet.enabled && styles.off,
                  )}
                >
                  <span {...stylex.props(settings.rowTitle, styles.wrap)}>{snippet.trigger}</span>
                  <p {...stylex.props(settings.rowDetail, styles.wrap, styles.expansion)}>
                    {snippet.expansion}
                  </p>
                </div>
                <div {...stylex.props(styles.rowActions)}>
                  <Switch
                    id={`snippet-enabled-${snippet.id}`}
                    label={`Enable ${snippet.trigger}`}
                    checked={snippet.enabled}
                    onChange={(enabled) => setEnabled(snippet, enabled)}
                  />
                  <Button
                    variant="icon"
                    aria-label={`Edit ${snippet.trigger}`}
                    title="Edit"
                    onClick={() => show("edit", snippet)}
                  >
                    <PencilIcon size={16} />
                  </Button>
                  <Button
                    variant="icon"
                    aria-label={`Delete ${snippet.trigger}`}
                    title="Delete"
                    onClick={() => show("delete", snippet)}
                  >
                    <Trash2Icon size={16} />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p {...stylex.props(settings.hint)}>
        Snippets type exactly what you saved. Cleanup never changes them.
      </p>
      {rowAction.error && (
        <p role="alert" {...stylex.props(settings.error)}>
          {rowAction.error}
        </p>
      )}

      {(modal?.kind === "add" || modal?.kind === "edit") && (
        <SnippetDialog
          // A new record remounts the dialog, even while the last one is still closing.
          key={modal.snippet.id}
          open={modal.open}
          onOpenChange={setOpen}
          onOpenChangeComplete={clearOnClose}
          mode={modal.kind}
          initial={modal.snippet}
          snippets={snippets}
        />
      )}
      {(modal?.kind === "delete" || modal?.kind === "deleted") && (
        <ConfirmDialog
          open={modal.open}
          onOpenChange={setOpen}
          onOpenChangeComplete={clearOnClose}
          // The deleted row's trash button leaves the DOM, so focus would otherwise fall to <body>.
          finalFocus={modal.kind === "deleted" ? addRef : undefined}
          title="Delete snippet?"
          description={`‘${modal.snippet.trigger}’ will be deleted permanently.`}
          actions={[
            { label: "Delete", variant: "destructive", onClick: () => remove(modal.snippet) },
          ]}
        />
      )}
    </div>
  );
}

function SnippetDialog({
  mode,
  initial,
  snippets,
  open,
  onOpenChange,
  onOpenChangeComplete,
}: {
  mode: Mode;
  initial: Snippet;
  snippets: readonly Snippet[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
}) {
  const triggerRef = useRef<HTMLInputElement>(null);
  const expansionRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(initial);
  const [saveAttempted, setSaveAttempted] = useState(false);
  const { pending, error, run, clearError } = useAction();
  const text = editorText[mode];
  const snippet = { ...draft, trigger: draft.trigger.trim() };
  const problem = snippetProblem(
    snippet,
    snippets.filter((other) => other.id !== snippet.id),
  );
  const shown = saveAttempted ? problem : null;

  const edit = (patch: Partial<Snippet>) => {
    clearError();
    setDraft({ ...draft, ...patch });
  };

  function save() {
    if (pending) return;
    if (problem) {
      setSaveAttempted(true);
      (problem.field === "trigger" ? triggerRef : expansionRef).current?.focus();
      return;
    }
    const next =
      mode === "add"
        ? [...snippets, snippet]
        : snippets.map((other) => (other.id === snippet.id ? snippet : other));
    void run(async () => {
      await hubApi().updateSettings({ snippets: next });
      onOpenChange(false);
    }, "Could not save this snippet. Try again.");
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
      disablePointerDismissal
    >
      <DialogFrame
        title={text.title}
        actions={
          <Button disabled={pending} onClick={save}>
            {text.save}
          </Button>
        }
      >
        <div {...stylex.props(styles.fields)}>
          <SnippetField
            label="Trigger"
            length={draft.trigger.length}
            max={TRIGGER_MAX_LENGTH}
            problem={messageFor("trigger", shown)}
          >
            <Field.Control
              ref={triggerRef}
              value={draft.trigger}
              maxLength={TRIGGER_MAX_LENGTH}
              autoComplete="off"
              spellCheck={false}
              placeholder="my email"
              onValueChange={(trigger) => edit({ trigger })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) save();
              }}
              {...stylex.props(styles.input, shown?.field === "trigger" && styles.invalid)}
            />
          </SnippetField>
          <SnippetField
            label="Expansion"
            length={draft.expansion.length}
            max={EXPANSION_MAX_LENGTH}
            problem={messageFor("expansion", shown)}
          >
            <Field.Control
              ref={expansionRef}
              render={<textarea />}
              value={draft.expansion}
              maxLength={EXPANSION_MAX_LENGTH}
              spellCheck={false}
              placeholder="name@example.com"
              onValueChange={(expansion) => edit({ expansion })}
              {...stylex.props(
                styles.input,
                styles.textarea,
                shown?.field === "expansion" && styles.invalid,
              )}
            />
          </SnippetField>
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

const messageFor = (field: SnippetProblem["field"], problem: SnippetProblem | null) =>
  problem?.field === field ? problem.message : undefined;

function SnippetField({
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

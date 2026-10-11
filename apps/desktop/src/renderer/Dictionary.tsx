import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import * as stylex from "@stylexjs/stylex";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

import {
  dictionaryProblem,
  PHRASE_MAX_LENGTH,
  REPLACEMENT_MAX_LENGTH,
  type DictionaryEntry,
  type DictionaryProblem,
} from "../shared/dictionary.ts";
import type { Snippet } from "../shared/snippets.ts";
import { Button } from "./Button.tsx";
import { ConfirmDialog, DialogFrame } from "./ConfirmDialog.tsx";
import { styles as settings } from "./Settings.tsx";
import { CountedField, styles } from "./Snippets.tsx";
import { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";

type Mode = "add" | "edit";
// Same lifecycle as the Snippets page: the record outlives `open` for the exit animation.
type Modal = { kind: Mode | "delete" | "deleted"; entry: DictionaryEntry; open: boolean };

const editorText: Record<Mode, { title: string; save: string }> = {
  add: { title: "Add to dictionary", save: "Add to dictionary" },
  edit: { title: "Edit dictionary entry", save: "Save changes" },
};

const label = (entry: DictionaryEntry) =>
  entry.replacement === null ? entry.phrase : `${entry.phrase} → ${entry.replacement}`;

export function Dictionary({
  dictionary,
  snippets,
}: {
  dictionary: readonly DictionaryEntry[];
  snippets: readonly Snippet[];
}) {
  const [modal, setModal] = useState<Modal | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const deleteAction = useAction();

  const show = (kind: Modal["kind"], entry: DictionaryEntry) =>
    setModal({ kind, entry, open: true });
  const setOpen = (open: boolean) => setModal((current) => current && { ...current, open });
  const clearOnClose = (open: boolean) => {
    if (!open) setModal(null);
  };

  const remove = (entry: DictionaryEntry) => {
    setModal((current) => current && { ...current, kind: "deleted" });
    void deleteAction.run(
      () =>
        hubApi().updateSettings({
          dictionary: dictionary.filter((other) => other.id !== entry.id),
        }),
      "Could not delete this entry. Try again.",
    );
  };

  return (
    <div {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.headerText)}>
          <h1 {...stylex.props(settings.headline)}>Dictionary</h1>
          <p {...stylex.props(styles.subtitle)}>
            Teach Voice how to write names and terms, or swap a phrase for other text.
          </p>
        </div>
        <Button
          ref={addRef}
          onClick={() => show("add", { id: crypto.randomUUID(), phrase: "", replacement: null })}
        >
          Add new
        </Button>
      </header>

      <div {...stylex.props(settings.card)}>
        {dictionary.length === 0 ? (
          <div {...stylex.props(settings.row)}>
            <div {...stylex.props(settings.rowText, styles.rowText)}>
              <span {...stylex.props(settings.rowTitle, styles.example)}>Wispr Flow</span>
            </div>
            <span {...stylex.props(settings.hint)}>Example</span>
          </div>
        ) : (
          <ul {...stylex.props(styles.list)}>
            {dictionary.map((entry) => (
              <li key={entry.id} {...stylex.props(settings.row)}>
                <div {...stylex.props(settings.rowText, styles.rowText)}>
                  <span {...stylex.props(settings.rowTitle, styles.wrap)}>{label(entry)}</span>
                </div>
                <div {...stylex.props(styles.rowActions)}>
                  <Button
                    variant="icon"
                    aria-label={`Edit ${entry.phrase}`}
                    title="Edit"
                    onClick={() => show("edit", entry)}
                  >
                    <PencilIcon size={16} />
                  </Button>
                  <Button
                    variant="icon"
                    aria-label={`Delete ${entry.phrase}`}
                    title="Delete"
                    onClick={() => show("delete", entry)}
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
        Voice writes a word the way you saved it, whatever its case or accents in speech. Add
        “Replace with” to type other text instead.
      </p>
      {deleteAction.error && (
        <p role="alert" {...stylex.props(settings.error)}>
          {deleteAction.error}
        </p>
      )}

      {(modal?.kind === "add" || modal?.kind === "edit") && (
        <EntryDialog
          // A new record remounts the dialog, even while the last one is still closing.
          key={modal.entry.id}
          open={modal.open}
          onOpenChange={setOpen}
          onOpenChangeComplete={clearOnClose}
          mode={modal.kind}
          initial={modal.entry}
          dictionary={dictionary}
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
          title="Delete from dictionary?"
          description={`‘${modal.entry.phrase}’ will be deleted permanently.`}
          actions={[
            { label: "Delete", variant: "destructive", onClick: () => remove(modal.entry) },
          ]}
        />
      )}
    </div>
  );
}

function EntryDialog({
  mode,
  initial,
  dictionary,
  snippets,
  open,
  onOpenChange,
  onOpenChangeComplete,
}: {
  mode: Mode;
  initial: DictionaryEntry;
  dictionary: readonly DictionaryEntry[];
  snippets: readonly Snippet[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
}) {
  const phraseRef = useRef<HTMLInputElement>(null);
  const replacementRef = useRef<HTMLInputElement>(null);
  const [phrase, setPhrase] = useState(initial.phrase);
  const [replacement, setReplacement] = useState(initial.replacement ?? "");
  const [saveAttempted, setSaveAttempted] = useState(false);
  const { pending, error, run, clearError } = useAction();
  const text = editorText[mode];
  // An empty "Replace with" makes a word entry.
  const entry: DictionaryEntry = {
    id: initial.id,
    phrase: phrase.trim(),
    replacement: replacement.trim() === "" ? null : replacement.trim(),
  };
  const problem = dictionaryProblem(
    entry,
    dictionary.filter((other) => other.id !== entry.id),
    snippets,
  );
  const shown = saveAttempted ? problem : null;

  function save() {
    if (pending) return;
    if (problem) {
      setSaveAttempted(true);
      (problem.field === "phrase" ? phraseRef : replacementRef).current?.focus();
      return;
    }
    const next =
      mode === "add"
        ? [...dictionary, entry]
        : dictionary.map((other) => (other.id === entry.id ? entry : other));
    void run(async () => {
      await hubApi().updateSettings({ dictionary: next });
      onOpenChange(false);
    }, "Could not save this entry. Try again.");
  }

  const saveOnEnter = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) save();
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
        actions={
          <Button disabled={pending} onClick={save}>
            {text.save}
          </Button>
        }
      >
        <div {...stylex.props(styles.fields)}>
          <CountedField
            label="Phrase"
            length={phrase.length}
            max={PHRASE_MAX_LENGTH}
            problem={messageFor("phrase", shown)}
          >
            <Field.Control
              ref={phraseRef}
              value={phrase}
              maxLength={PHRASE_MAX_LENGTH}
              autoComplete="off"
              spellCheck={false}
              placeholder="Wispr Flow"
              onValueChange={(value) => {
                clearError();
                setPhrase(value);
              }}
              onKeyDown={saveOnEnter}
              {...stylex.props(styles.input, shown?.field === "phrase" && styles.invalid)}
            />
          </CountedField>
          <CountedField
            label="Replace with"
            length={replacement.length}
            max={REPLACEMENT_MAX_LENGTH}
            problem={messageFor("replacement", shown)}
          >
            <Field.Control
              ref={replacementRef}
              value={replacement}
              maxLength={REPLACEMENT_MAX_LENGTH}
              autoComplete="off"
              spellCheck={false}
              placeholder="Optional"
              onValueChange={(value) => {
                clearError();
                setReplacement(value);
              }}
              onKeyDown={saveOnEnter}
              {...stylex.props(styles.input, shown?.field === "replacement" && styles.invalid)}
            />
          </CountedField>
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

const messageFor = (field: DictionaryProblem["field"], problem: DictionaryProblem | null) =>
  problem?.field === field ? problem.message : undefined;

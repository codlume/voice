import { Field } from "@base-ui/react/field";
import * as stylex from "@stylexjs/stylex";

import {
  dictionaryProblem,
  PHRASE_MAX_LENGTH,
  REPLACEMENT_MAX_LENGTH,
  type DictionaryEntry,
} from "../shared/dictionary.ts";
import type { Snippet } from "../shared/snippets.ts";
import { CountedField, RecordList, styles, type Copy } from "./RecordList.tsx";
import { hubApi } from "./voice.ts";

const copy: Copy = {
  title: "Dictionary",
  subtitle: "Teach Voice how to write names and terms, or swap a phrase for other text.",
  hint:
    "Voice writes a word the way you saved it, whatever its case or accents in speech. Add " +
    "“Replace with” to type other text instead.",
  deleteTitle: "Delete from dictionary?",
  editor: {
    add: { title: "Add to dictionary", save: "Add to dictionary" },
    edit: { title: "Edit dictionary entry", save: "Save changes" },
  },
  saveFailed: "Could not save this entry. Try again.",
  deleteFailed: "Could not delete this entry. Try again.",
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
  return (
    <RecordList
      copy={copy}
      records={dictionary}
      save={(next) => hubApi().updateSettings({ dictionary: next })}
      blank={() => ({ id: crypto.randomUUID(), phrase: "", replacement: null })}
      name={(entry) => entry.phrase}
      example={{ title: "Wispr Flow" }}
      row={(entry) => ({ title: label(entry) })}
      // An empty "Replace with" makes a word entry.
      normalize={(draft) => {
        const replacement = draft.replacement?.trim() ?? "";
        return {
          id: draft.id,
          phrase: draft.phrase.trim(),
          replacement: replacement === "" ? null : replacement,
        };
      }}
      problem={(entry, others) => dictionaryProblem(entry, others, snippets)}
      renderFields={({ draft, edit, shown, message, saveOnEnter }) => (
        <>
          <CountedField
            label="Phrase"
            length={draft.phrase.length}
            max={PHRASE_MAX_LENGTH}
            problem={message("phrase")}
          >
            <Field.Control
              value={draft.phrase}
              maxLength={PHRASE_MAX_LENGTH}
              autoComplete="off"
              spellCheck={false}
              placeholder="Wispr Flow"
              onValueChange={(phrase) => edit({ phrase })}
              onKeyDown={saveOnEnter}
              {...stylex.props(styles.input, shown?.field === "phrase" && styles.invalid)}
            />
          </CountedField>
          <CountedField
            label="Replace with"
            length={(draft.replacement ?? "").length}
            max={REPLACEMENT_MAX_LENGTH}
            problem={message("replacement")}
          >
            <Field.Control
              value={draft.replacement ?? ""}
              maxLength={REPLACEMENT_MAX_LENGTH}
              autoComplete="off"
              spellCheck={false}
              placeholder="Optional"
              onValueChange={(replacement) => edit({ replacement })}
              onKeyDown={saveOnEnter}
              {...stylex.props(styles.input, shown?.field === "replacement" && styles.invalid)}
            />
          </CountedField>
        </>
      )}
    />
  );
}

import { Field } from "@base-ui/react/field";
import * as stylex from "@stylexjs/stylex";

import {
  dictionaryEntry,
  dictionaryProblem,
  PHRASE_MAX_LENGTH,
  REPLACEMENT_MAX_LENGTH,
  type DictionaryEntry,
  type DictionaryProblem,
} from "../shared/dictionary.ts";
import type { Snippet } from "../shared/snippets.ts";
import { Input } from "./Input.tsx";
import { pageStyles } from "./pageStyles.ts";
import { RecordList, styles, type Copy } from "./RecordList.tsx";
import { styles as settings } from "./settingsParts.tsx";
import { Switch } from "./Switch.tsx";
import { color, space } from "./tokens.stylex.ts";
import { hubApi } from "./voice.ts";

const local = stylex.create({
  toggle: { display: "flex", alignItems: "center", gap: space.lg, marginBottom: space.sm },
  inputs: { display: "flex", alignItems: "center", gap: space.sm },
  cell: { flexBasis: 0, flexGrow: 1, minWidth: 0 },
  arrow: { flexShrink: 0, color: color.mutedForeground },
});

const switchId = "dictionary-replace";
const problemId = "dictionary-problem";

const copy: Copy = {
  title: "Dictionary",
  subtitle: "Teach Voice how to write names and terms, or swap a phrase for other text.",
  hint:
    "Voice writes a word the way you saved it, whatever its case or accents in speech. Turn on " +
    "“Replace with other text” to type something else instead.",
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
      example={{ title: "Worcestershire" }}
      row={(entry) => ({ title: label(entry) })}
      normalize={dictionaryEntry}
      problem={(entry, others) => dictionaryProblem(entry, others, snippets)}
      renderFields={({ draft, edit, shown, saveOnEnter }) => {
        const { replacement } = draft;
        const replacing = replacement !== null;
        const invalid = (field: DictionaryProblem["field"]) => shown?.field === field;
        const input = (field: DictionaryProblem["field"]) => ({
          autoComplete: "off",
          spellCheck: false,
          onKeyDown: saveOnEnter,
          invalid: invalid(field),
          "aria-describedby": invalid(field) ? problemId : undefined,
        });
        return (
          <>
            <div {...stylex.props(local.toggle)}>
              <label htmlFor={switchId} {...stylex.props(settings.rowText, settings.rowTitle)}>
                Replace with other text
              </label>
              <Switch
                id={switchId}
                checked={replacing}
                onChange={(on) => edit({ replacement: on ? "" : null })}
              />
            </div>
            <div {...stylex.props(styles.field)}>
              <div {...stylex.props(local.inputs)}>
                <Field.Root invalid={invalid("phrase")} {...stylex.props(local.cell)}>
                  <Input
                    value={draft.phrase}
                    maxLength={PHRASE_MAX_LENGTH}
                    placeholder={replacing ? "Phrase" : "Add a new word"}
                    aria-label={replacing ? "Phrase" : "Word or phrase"}
                    onChange={(event) => edit({ phrase: event.currentTarget.value })}
                    {...input("phrase")}
                  />
                </Field.Root>
                {replacing && (
                  <>
                    <span aria-hidden="true" {...stylex.props(local.arrow)}>
                      →
                    </span>
                    <Field.Root invalid={invalid("replacement")} {...stylex.props(local.cell)}>
                      <Input
                        value={replacement}
                        maxLength={REPLACEMENT_MAX_LENGTH}
                        placeholder="Replace with"
                        aria-label="Replace with"
                        onChange={(event) => edit({ replacement: event.currentTarget.value })}
                        {...input("replacement")}
                      />
                    </Field.Root>
                  </>
                )}
              </div>
              {shown && (
                <p id={problemId} {...stylex.props(pageStyles.error)}>
                  {shown.message}
                </p>
              )}
            </div>
          </>
        );
      }}
    />
  );
}

import { Field } from "@base-ui/react/field";
import * as stylex from "@stylexjs/stylex";

import type { DictionaryEntry } from "../shared/dictionary.ts";
import {
  EXPANSION_MAX_LENGTH,
  snippetProblem,
  TRIGGER_MAX_LENGTH,
  type Snippet,
} from "../shared/snippets.ts";
import { CountedField, RecordList, styles, type Copy } from "./RecordList.tsx";
import { Switch } from "./Switch.tsx";
import { hubApi } from "./voice.ts";

const copy: Copy = {
  title: "Snippets",
  subtitle: "Say a short phrase and Voice types the saved text, anywhere you dictate.",
  hint: "Snippets type exactly what you saved. Cleanup never changes them.",
  deleteTitle: "Delete snippet?",
  editor: {
    add: { title: "Add snippet", save: "Add snippet" },
    edit: { title: "Edit snippet", save: "Save changes" },
  },
  saveFailed: "Could not save this snippet. Try again.",
  deleteFailed: "Could not delete this snippet. Try again.",
};

export function Snippets({
  snippets,
  dictionary,
}: {
  snippets: readonly Snippet[];
  dictionary: readonly DictionaryEntry[];
}) {
  return (
    <RecordList
      copy={copy}
      records={snippets}
      save={(next) => hubApi().updateSettings({ snippets: next })}
      blank={() => ({
        id: crypto.randomUUID(),
        trigger: "",
        expansion: "",
        expansionHtml: null,
        enabled: true,
      })}
      name={(snippet) => snippet.trigger}
      example={{ title: "my email", detail: "name@example.com" }}
      row={(snippet) => ({
        title: snippet.trigger,
        detail: snippet.expansion,
        faded: !snippet.enabled,
      })}
      renderControls={(snippet, change) => (
        <Switch
          id={`snippet-enabled-${snippet.id}`}
          label={`Enable ${snippet.trigger}`}
          checked={snippet.enabled}
          onChange={(enabled) =>
            change(
              snippets.map((other) => (other.id === snippet.id ? { ...other, enabled } : other)),
              "Could not change this snippet. Try again.",
            )
          }
        />
      )}
      normalize={(draft) => ({ ...draft, trigger: draft.trigger.trim() })}
      problem={(snippet, others) => snippetProblem(snippet, others, dictionary)}
      renderFields={({ draft, edit, shown, message, saveOnEnter }) => (
        <>
          <CountedField
            label="Trigger"
            length={draft.trigger.length}
            max={TRIGGER_MAX_LENGTH}
            problem={message("trigger")}
          >
            <Field.Control
              value={draft.trigger}
              maxLength={TRIGGER_MAX_LENGTH}
              autoComplete="off"
              spellCheck={false}
              placeholder="my email"
              onValueChange={(trigger) => edit({ trigger })}
              onKeyDown={saveOnEnter}
              {...stylex.props(styles.input, shown?.field === "trigger" && styles.invalid)}
            />
          </CountedField>
          <CountedField
            label="Expansion"
            length={draft.expansion.length}
            max={EXPANSION_MAX_LENGTH}
            problem={message("expansion")}
          >
            <Field.Control
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
          </CountedField>
        </>
      )}
    />
  );
}

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
import { styles as settings } from "./Settings.tsx";
import { SnippetEditor } from "./SnippetEditor.tsx";
import { Switch } from "./Switch.tsx";
import { space } from "./tokens.stylex.ts";
import { hubApi } from "./voice.ts";

const local = stylex.create({
  toggle: { display: "flex", alignItems: "center", gap: space.lg },
  toggleLabel: { fontSize: 13 },
});

// Only one editor dialog is open at a time.
const switchId = "snippet-enabled";

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
        off: !snippet.enabled,
      })}
      normalize={(draft) => ({ ...draft, trigger: draft.trigger.trim() })}
      problem={(snippet, others) => snippetProblem(snippet, others, dictionary)}
      wide
      renderFields={({ draft, edit, shown, message, submit, saveOnEnter }) => (
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
            <SnippetEditor
              defaultValue={draft}
              invalid={shown?.field === "expansion"}
              onChange={edit}
              onSave={submit}
            />
          </CountedField>
          <div {...stylex.props(local.toggle)}>
            <label htmlFor={switchId} {...stylex.props(settings.rowText, local.toggleLabel)}>
              Enabled
            </label>
            <Switch
              id={switchId}
              checked={draft.enabled}
              onChange={(enabled) => edit({ enabled })}
            />
          </div>
        </>
      )}
    />
  );
}

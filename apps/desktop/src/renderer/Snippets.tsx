import * as stylex from "@stylexjs/stylex";
import { lazy, Suspense, useEffect, useId } from "react";

import type { DictionaryEntry } from "../shared/dictionary.ts";
import {
  EXPANSION_MAX_LENGTH,
  snippetProblem,
  TRIGGER_MAX_LENGTH,
  type Snippet,
} from "../shared/snippets.ts";
import { Input } from "./Input.tsx";
import { CountedField, RecordList, type Copy } from "./RecordList.tsx";
import { surfaces } from "./surfaces.ts";
import { Switch } from "./Switch.tsx";
import { leading, snippetEditor, space, text } from "./tokens.stylex.ts";
import { hubApi } from "./voice.ts";

const loadSnippetEditor = () => import("./SnippetEditor.tsx");
const SnippetEditor = lazy(() =>
  loadSnippetEditor().then((module) => ({ default: module.SnippetEditor })),
);

const local = stylex.create({
  footerSwitch: { display: "flex", alignItems: "center", gap: space.sm },
  footerSwitchLabel: { fontSize: text.sm, lineHeight: leading.sm },
  editorLoading: { minHeight: snippetEditor.minHeight },
});

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
  useEffect(() => {
    void loadSnippetEditor();
  }, []);
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
            <Input
              value={draft.trigger}
              maxLength={TRIGGER_MAX_LENGTH}
              autoComplete="off"
              spellCheck={false}
              placeholder="my email"
              invalid={shown?.field === "trigger"}
              onChange={(event) => edit({ trigger: event.currentTarget.value })}
              onKeyDown={saveOnEnter}
            />
          </CountedField>
          <CountedField
            label="Expansion"
            length={draft.expansion.length}
            max={EXPANSION_MAX_LENGTH}
            problem={message("expansion")}
          >
            <Suspense
              fallback={<div aria-busy {...stylex.props(surfaces.control, local.editorLoading)} />}
            >
              <SnippetEditor
                defaultValue={draft}
                invalid={shown?.field === "expansion"}
                onChange={edit}
                onSave={submit}
              />
            </Suspense>
          </CountedField>
        </>
      )}
      renderFooter={({ draft, edit }) => (
        <FooterSwitch
          label="Enabled"
          checked={draft.enabled}
          onChange={(enabled) => edit({ enabled })}
        />
      )}
    />
  );
}

function FooterSwitch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div {...stylex.props(local.footerSwitch)}>
      <Switch id={id} checked={checked} onChange={onChange} />
      <label htmlFor={id} {...stylex.props(local.footerSwitchLabel)}>
        {label}
      </label>
    </div>
  );
}

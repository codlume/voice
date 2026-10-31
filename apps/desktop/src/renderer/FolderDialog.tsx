import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import * as stylex from "@stylexjs/stylex";
import { useState, type KeyboardEvent } from "react";

import type { Folder, FolderDraft } from "../shared/meetings.ts";
import { Button } from "./Button.tsx";
import { DialogFrame } from "./ConfirmDialog.tsx";
import { pageStyles } from "./pageStyles.ts";
import { styles as record } from "./RecordList.tsx";
import { Segmented, styles as settings } from "./Settings.tsx";
import { useAction } from "./useAction.ts";

type Kind = FolderDraft["kind"];

const kinds = [
  { value: "manual", label: "Manual" },
  { value: "auto", label: "Automatic" },
] as const satisfies readonly { value: Kind; label: string }[];

function draftOf(name: string, kind: Kind, keyword: string): FolderDraft | null {
  if (name.trim() === "") return null;
  if (kind === "manual") return { name: name.trim(), kind };
  if (keyword.trim() === "") return null;
  return { name: name.trim(), kind, rule: { kind: "titleContains", text: keyword.trim() } };
}

/**
 * Creates a folder, or edits `folder`. `save` gets the draft and closes the dialog once it
 * resolves; a rejection stays in the dialog as an error.
 */
export function FolderDialog({
  folder,
  open,
  onOpenChange,
  save,
}: {
  folder: Folder | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  save: (draft: FolderDraft) => Promise<void>;
}) {
  const [name, setName] = useState(folder?.name ?? "");
  const [kind, setKind] = useState<Kind>(folder?.kind ?? "manual");
  const [keyword, setKeyword] = useState(folder?.kind === "auto" ? folder.rule.text : "");
  const [tried, setTried] = useState(false);
  const { pending, error, run } = useAction();
  const draft = draftOf(name, kind, keyword);

  function submit() {
    if (pending) return;
    setTried(true);
    if (!draft) return;
    void run(async () => {
      await save(draft);
      onOpenChange(false);
    }, "Could not save this folder. Try again.");
  }
  const saveOnEnter = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) submit();
  };
  const nameMissing = tried && name.trim() === "";
  const keywordMissing = tried && kind === "auto" && keyword.trim() === "";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} disablePointerDismissal>
      <DialogFrame
        title={folder ? "Edit folder" : "New folder"}
        actions={
          <Button disabled={pending} onClick={submit}>
            {folder ? "Save" : "Create folder"}
          </Button>
        }
      >
        <div {...stylex.props(record.fields)}>
          <Field.Root invalid={nameMissing} {...stylex.props(record.field)}>
            <Field.Label {...stylex.props(settings.sectionLabel)}>Name</Field.Label>
            <Field.Control
              autoFocus
              value={name}
              placeholder="Weekly standup"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={saveOnEnter}
              {...stylex.props(record.input, nameMissing && record.invalid)}
            />
            {nameMissing && (
              <Field.Error match {...stylex.props(pageStyles.error)}>
                Name the folder.
              </Field.Error>
            )}
          </Field.Root>
          <Field.Root {...stylex.props(record.field)}>
            <Field.Label {...stylex.props(settings.sectionLabel)}>Type</Field.Label>
            <Segmented options={kinds} value={kind} onChange={setKind} />
            <Field.Description {...stylex.props(settings.hint)}>
              {kind === "manual"
                ? "You choose which meetings go in it."
                : "Meetings whose title contains a word go in it, including the meetings you already have."}
            </Field.Description>
          </Field.Root>
          {kind === "auto" && (
            <Field.Root invalid={keywordMissing} {...stylex.props(record.field)}>
              <Field.Label {...stylex.props(settings.sectionLabel)}>Title contains</Field.Label>
              <Field.Control
                value={keyword}
                placeholder="standup"
                onChange={(event) => setKeyword(event.target.value)}
                onKeyDown={saveOnEnter}
                {...stylex.props(record.input, keywordMissing && record.invalid)}
              />
              {keywordMissing && (
                <Field.Error match {...stylex.props(pageStyles.error)}>
                  Enter a word to look for in titles.
                </Field.Error>
              )}
            </Field.Root>
          )}
        </div>
        {error && (
          <p role="alert" {...stylex.props(pageStyles.error, record.saveError)}>
            {error}
          </p>
        )}
      </DialogFrame>
    </Dialog.Root>
  );
}

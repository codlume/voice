import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useRef, useState } from "react";

import type { ModelStatus, Settings, SettingsPatch } from "../shared/api.ts";
import {
  newTransformId,
  restoreDefaults,
  transformProblem,
  type LastTransform,
  type Transform,
} from "../shared/transforms.ts";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { dictationKeys } from "./hotkeys.ts";
import { pageStyles } from "./pageStyles.ts";
import { RecordEditor, type Copy } from "./RecordList.tsx";
import { Select } from "./Select.tsx";
import { styles as settingsStyles } from "./Settings.tsx";
import { shortcutKeys } from "./shortcutCapture.ts";
import { Keys, useKeyboardLayout } from "./ShortcutPicker.tsx";
import { Switch } from "./Switch.tsx";
import { color, radius, space } from "./tokens.stylex.ts";
import { TransformFields } from "./TransformFields.tsx";
import {
  askToDelete,
  asksBeforeTurningOn,
  autoApplyChoice,
  autoApplyOptions,
  cancelDelete,
  confirmDelete,
  firstLine,
  modelLine,
  NO_AUTO_APPLY,
  openEditor,
  restoreDescription,
  TRANSFORM_MODEL_SIZE,
  type EditorModal,
  type Modal,
} from "./transformsView.ts";
import { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.xl },
  header: { display: "flex", flexDirection: "column", gap: space.sm },
  subtitle: { margin: 0, color: color.mutedForeground },
  sectionHead: { display: "flex", alignItems: "center", gap: space.sm },
  sectionTitle: { flexGrow: 1 },
  link: { fontSize: 12.5, textDecoration: "underline" },
  grid: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 1fr))",
      "@media (max-width: 780px)": "minmax(0, 1fr)",
    },
    gap: space.md,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: space.sm,
    minHeight: 96,
    paddingBlock: space.md,
    paddingInline: space.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: color.border, ":hover": color.input },
    borderRadius: radius.large,
    backgroundColor: { default: color.card, ":hover": color.accent },
    color: color.foreground,
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
    outline: { default: "none", ":focus-visible": `2px solid ${color["--ring"]}` },
    outlineOffset: 3,
  },
  cardHeader: { display: "flex", alignItems: "center", gap: space.sm },
  cardTitle: { flexGrow: 1, minWidth: 0, fontWeight: 600, overflowWrap: "anywhere" },
  instruction: {
    display: "-webkit-box",
    margin: 0,
    overflow: "hidden",
    color: color.mutedForeground,
    fontSize: 12.5,
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
  },
  noShortcut: { color: color.mutedForeground, fontSize: 12 },
  last: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 1fr))",
      "@media (max-width: 780px)": "minmax(0, 1fr)",
    },
    gap: space.lg,
    padding: space.lg,
  },
  lastColumn: { display: "flex", flexDirection: "column", gap: space.sm, minWidth: 0 },
  lastText: {
    flexGrow: 1,
    maxHeight: 200,
    margin: 0,
    overflowY: "auto",
    fontSize: 13,
    lineHeight: 1.45,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  empty: { padding: space.lg },
});

const EDITOR_COPY: Pick<Copy, "editor" | "saveFailed"> = {
  editor: {
    add: { title: "Create transform", save: "Create transform" },
    edit: { title: "Edit transform", save: "Save changes" },
  },
  saveFailed: "Could not save this transform. Try again.",
};

const normalize = (draft: Transform): Transform => ({
  ...draft,
  name: draft.name.trim(),
  instruction: draft.instruction.trim(),
});

const saveItems = (next: readonly Transform[]) =>
  hubApi().updateSettings({ transforms: { items: next } });

const blank = (): Transform => ({
  id: newTransformId(),
  name: "",
  instruction: "",
  shortcut: null,
});

export function Transforms({
  settings,
  model,
  onOpenModels,
}: {
  settings: Settings;
  model: ModelStatus;
  onOpenModels: () => void;
}) {
  const switchId = useId();
  const autoApplyId = useId();
  const { enabled, items, autoApply } = settings.transforms;
  const layout = useKeyboardLayout();
  const [modal, setModal] = useState<Modal | null>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const action = useAction();
  const line = modelLine(enabled, model);

  const update = (transforms: NonNullable<SettingsPatch["transforms"]>, failed: string) =>
    action.run(() => hubApi().updateSettings({ transforms }), failed);
  const setOpen = (open: boolean) => setModal((current) => current && { ...current, open });
  const clearOnClose = (open: boolean) => {
    if (!open) setModal(null);
  };
  const turn = (on: boolean) => {
    if (asksBeforeTurningOn(on, model)) setModal({ kind: "download", open: true });
    else void update({ enabled: on }, "Could not change Transforms. Try again.");
  };
  const edit = (kind: EditorModal["kind"], transform: Transform) =>
    setModal(openEditor(kind, transform, crypto.randomUUID()));
  // Updates from the current state: the confirm's Delete fires its click and its close together.
  const changeEditor = (change: (editor: EditorModal) => EditorModal) =>
    setModal((current) =>
      current?.kind === "add" || current?.kind === "edit" ? change(current) : current,
    );

  return (
    <div {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.header)}>
        <h1 {...stylex.props(pageStyles.headline)}>Transforms</h1>
        <p {...stylex.props(styles.subtitle)}>
          Select text in any app, press a shortcut, and Voice rewrites it in place.
        </p>
      </header>

      <Card>
        <div {...stylex.props(settingsStyles.row)}>
          <div {...stylex.props(settingsStyles.rowText)}>
            <label htmlFor={switchId} {...stylex.props(settingsStyles.rowTitle)}>
              Transforms
            </label>
            <p {...stylex.props(settingsStyles.rowDetail)}>
              {line.text}{" "}
              {line.linksToModels && (
                <Button variant="text" onClick={onOpenModels}>
                  <span {...stylex.props(styles.link)}>Open Models</span>
                </Button>
              )}
            </p>
          </div>
          <Switch id={switchId} checked={enabled} onChange={turn} />
        </div>
        <div {...stylex.props(settingsStyles.row, !enabled && settingsStyles.disabled)}>
          <div {...stylex.props(settingsStyles.rowText)}>
            <label htmlFor={autoApplyId} {...stylex.props(settingsStyles.rowTitle)}>
              After dictation
            </label>
            <p {...stylex.props(settingsStyles.rowDetail)}>
              Runs on every dictation in place of cleanup. It can shorten what you said. Your
              original words stay in History when History is on, and in Last transform until Voice
              quits.
            </p>
          </div>
          <Select
            id={autoApplyId}
            value={autoApply ?? NO_AUTO_APPLY}
            options={autoApplyOptions(items)}
            disabled={!enabled}
            onChange={(value) =>
              void update(
                { autoApply: autoApplyChoice(items, value) },
                "Could not save your choice. Try again.",
              )
            }
          />
        </div>
      </Card>
      {action.error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {action.error}
        </p>
      )}

      <section aria-label="Your transforms" {...stylex.props(settingsStyles.section)}>
        <div {...stylex.props(styles.sectionHead)}>
          <h2 {...stylex.props(settingsStyles.sectionLabel, styles.sectionTitle)}>
            Your transforms
          </h2>
          <Button variant="secondary" onClick={() => setModal({ kind: "restore", open: true })}>
            Restore defaults
          </Button>
          <Button ref={createRef} onClick={() => edit("add", blank())}>
            Create
          </Button>
        </div>
        {items.length === 0 ? (
          <Card style={styles.empty}>
            <p {...stylex.props(settingsStyles.hint)}>
              No transforms. Create one, or restore Polish and Prompt Engineer.
            </p>
          </Card>
        ) : (
          <div {...stylex.props(styles.grid)}>
            {items.map((transform) => (
              <button
                key={transform.id}
                type="button"
                aria-label={`Edit ${transform.name}`}
                onClick={() => edit("edit", transform)}
                {...stylex.props(styles.card)}
              >
                <span {...stylex.props(styles.cardHeader)}>
                  <span {...stylex.props(styles.cardTitle)}>{transform.name}</span>
                  {transform.shortcut ? (
                    <Keys keys={shortcutKeys(transform.shortcut, layout)} />
                  ) : (
                    <span {...stylex.props(styles.noShortcut)}>No shortcut</span>
                  )}
                </span>
                <span {...stylex.props(styles.instruction)}>
                  {firstLine(transform.instruction)}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <LastTransformPanel />

      <p {...stylex.props(settingsStyles.hint)}>
        Transforms run on this Mac. Voice keeps nothing except the last run, in memory, until it
        quits. When an app has no accessibility support, Voice copies the selection through the
        clipboard for a moment, which clipboard managers may record. Formatting such as bold and
        links is not kept.
      </p>

      {(modal?.kind === "add" || modal?.kind === "edit") && (
        <RecordEditor
          key={modal.key}
          mode={modal.kind}
          initial={modal.transform}
          records={items}
          copy={EDITOR_COPY}
          save={saveItems}
          normalize={normalize}
          problem={transformProblem}
          wide
          renderFields={(editor) => (
            <TransformFields
              editor={editor}
              others={items.filter(({ id }) => id !== editor.draft.id)}
              layout={layout}
              dictationKeys={dictationKeys(settings)}
            />
          )}
          renderFooter={() =>
            modal.kind === "edit" && (
              <>
                <Button variant="text" onClick={() => changeEditor(askToDelete)}>
                  Delete transform
                </Button>
                <ConfirmDialog
                  open={modal.deletion === "confirming"}
                  onOpenChange={(open) => {
                    if (!open) changeEditor(cancelDelete);
                  }}
                  finalFocus={modal.deletion === "confirmed" ? createRef : undefined}
                  title="Delete transform?"
                  description={`‘${modal.transform.name}’ will be deleted permanently.`}
                  actions={[
                    {
                      label: "Delete",
                      variant: "destructive",
                      onClick: () => {
                        changeEditor(confirmDelete);
                        void update(
                          { items: items.filter(({ id }) => id !== modal.transform.id) },
                          "Could not delete this transform. Try again.",
                        );
                      },
                    },
                  ]}
                />
              </>
            )
          }
          // The deleted transform's card and its editor leave the page, so both dialogs send focus
          // to Create instead of letting it fall to <body>.
          finalFocus={modal.deletion === "confirmed" ? createRef : undefined}
          open={modal.open}
          onOpenChange={setOpen}
          onOpenChangeComplete={clearOnClose}
        />
      )}
      {modal?.kind === "restore" && (
        <ConfirmDialog
          open={modal.open}
          onOpenChange={setOpen}
          onOpenChangeComplete={clearOnClose}
          title="Restore default transforms?"
          description={restoreDescription(items, layout)}
          actions={[
            {
              label: "Restore",
              variant: "primary",
              onClick: () =>
                void update(
                  { items: restoreDefaults(items) },
                  "Could not restore the defaults. Try again.",
                ),
            },
          ]}
        />
      )}
      {modal?.kind === "download" && (
        <ConfirmDialog
          open={modal.open}
          onOpenChange={setOpen}
          onOpenChangeComplete={clearOnClose}
          title={`Download the ${TRANSFORM_MODEL_SIZE} transform model?`}
          description={`Transforms run on a ${TRANSFORM_MODEL_SIZE} model on this Mac. Voice downloads it once when you turn Transforms on.`}
          actions={[
            {
              label: "Download and turn on",
              variant: "primary",
              onClick: () =>
                void update({ enabled: true }, "Could not change Transforms. Try again."),
            },
          ]}
        />
      )}
    </div>
  );
}

/** Null until main answers, and null when main has no last run, which is the state after launch. */
function useLastTransform(): LastTransform | null {
  const [last, setLast] = useState<LastTransform | null>(null);
  useEffect(() => {
    let answerStale = false;
    const unsubscribe = hubApi().onLastTransform((next) => {
      answerStale = true;
      setLast(next);
    });
    hubApi()
      .getLastTransform()
      .then(
        (first) => {
          if (!answerStale) setLast(first);
        },
        // Without an answer there is no run to show, which the empty panel already says.
        () => {},
      );
    return () => {
      answerStale = true;
      unsubscribe();
    };
  }, []);
  return last;
}

function LastTransformPanel() {
  const last = useLastTransform();
  const copy = useAction();
  return (
    <section aria-label="Last transform" {...stylex.props(settingsStyles.section)}>
      <h2 {...stylex.props(settingsStyles.sectionLabel)}>Last transform</h2>
      <Card>
        {last === null ? (
          <p {...stylex.props(settingsStyles.hint, styles.empty)}>
            Your last transform shows here, so you can copy the original back. Voice forgets it when
            it quits.
          </p>
        ) : (
          <div {...stylex.props(styles.last)}>
            <LastColumn
              title="Before"
              text={last.before}
              copyLabel="Copy original"
              onCopy={() =>
                void copy.run(
                  () => hubApi().copyLastTransform("before"),
                  "Could not copy the original. Try again.",
                )
              }
            />
            <LastColumn
              title={`After ${last.name}`}
              text={last.after}
              copyLabel="Copy result"
              onCopy={() =>
                void copy.run(
                  () => hubApi().copyLastTransform("after"),
                  "Could not copy the result. Try again.",
                )
              }
            />
          </div>
        )}
      </Card>
      {copy.error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {copy.error}
        </p>
      )}
    </section>
  );
}

function LastColumn({
  title,
  text,
  copyLabel,
  onCopy,
}: {
  title: string;
  text: string;
  copyLabel: string;
  onCopy: () => void;
}) {
  return (
    <div {...stylex.props(styles.lastColumn)}>
      <span {...stylex.props(settingsStyles.rowTitle)}>{title}</span>
      <p {...stylex.props(styles.lastText)}>{text}</p>
      <div>
        <Button variant="secondary" onClick={onCopy}>
          {copyLabel}
        </Button>
      </div>
    </div>
  );
}

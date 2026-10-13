import { Field } from "@base-ui/react/field";
import { $isLinkNode, $createLinkNode, $toggleLink, LinkNode } from "@lexical/link";
import {
  $isListNode,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  REMOVE_LIST_COMMAND,
} from "@lexical/list";
import { BOLD_STAR, ITALIC_STAR, LINK, ORDERED_LIST, UNORDERED_LIST } from "@lexical/markdown";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import * as stylex from "@stylexjs/stylex";
import {
  $createTextNode,
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH,
  FORMAT_ELEMENT_COMMAND,
  FORMAT_TEXT_COMMAND,
  INDENT_CONTENT_COMMAND,
  IS_APPLE,
  IS_BOLD,
  IS_ITALIC,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  ParagraphNode,
  TextNode,
  type BaseSelection,
  type LexicalNode,
} from "lexical";
import { BoldIcon, ItalicIcon, LinkIcon, ListIcon, ListOrderedIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState, type MouseEvent, type ReactNode } from "react";

import { Button } from "./Button.tsx";
import { styles as form } from "./RecordList.tsx";
import {
  $readSnippetText,
  $writeSnippetText,
  allowedHref,
  hrefFromInput,
  snippetNodes,
  type SnippetText,
} from "./snippetText.ts";
import { color, radius } from "./tokens.stylex.ts";

const styles = stylex.create({
  box: {
    display: "flex",
    flexDirection: "column",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: color.border, ":focus-within": color.input },
    borderRadius: radius.medium,
    backgroundColor: color.card,
    color: color.foreground,
    outline: {
      default: "none",
      ":has([contenteditable]:focus-visible)": "2px solid var(--ring)",
    },
    outlineOffset: 2,
  },
  invalid: { borderColor: { default: color.error, ":focus-within": color.error } },
  toolbar: { display: "flex", alignItems: "center", gap: 2, paddingTop: 4, paddingInline: 4 },
  divider: {
    width: 1,
    height: 16,
    marginBlock: 0,
    marginInline: 4,
    backgroundColor: color.border,
  },
  linkRow: { display: "flex", alignItems: "center", gap: 6, paddingTop: 6, paddingInline: 6 },
  linkInput: { flexGrow: 1, width: "auto", minWidth: 0, paddingBlock: 5 },
  surface: { position: "relative" },
  content: {
    minHeight: 140,
    maxHeight: 280,
    overflowY: "auto",
    paddingBlock: 6,
    paddingInline: 10,
    fontSize: 13,
    lineHeight: 1.45,
    overflowWrap: "anywhere",
    outline: "none",
  },
  placeholder: {
    position: "absolute",
    top: 6,
    left: 10,
    fontSize: 13,
    lineHeight: 1.45,
    color: color.mutedForeground,
    pointerEvents: "none",
    userSelect: "none",
  },
});

const content = stylex.create({
  paragraph: { margin: 0 },
  list: { marginBlock: 2, marginInline: 0, paddingInlineStart: 22 },
  link: { color: color.primary },
});
const className = (style: stylex.StyleXStyles) => stylex.props(style).className ?? "";
const theme = {
  paragraph: className(content.paragraph),
  list: { ul: className(content.list), ol: className(content.list) },
  link: className(content.link),
};

const KEPT_FORMATS = IS_BOLD | IS_ITALIC;
const shortcut = (key: string) => (IS_APPLE ? `⌘${key}` : `Ctrl+${key}`);
const isShortcut = (event: KeyboardEvent | null): event is KeyboardEvent =>
  event !== null && (IS_APPLE ? event.metaKey : event.ctrlKey) && !event.altKey;

type Formats = {
  bold: boolean;
  italic: boolean;
  list: "bullet" | "number" | null;
  link: string | null;
};

const NO_FORMATS: Formats = { bold: false, italic: false, list: null, link: null };

function $nearestLink(node: LexicalNode | null): LinkNode | null {
  for (let current = node; current !== null; current = current.getParent()) {
    if ($isLinkNode(current)) return current;
  }
  return null;
}

function $readFormats(): Formats {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return NO_FORMATS;
  const anchor = selection.anchor.getNode();
  const block = anchor.getTopLevelElement();
  const listType = $isListNode(block) ? block.getListType() : null;
  return {
    bold: selection.hasFormat("bold"),
    italic: selection.hasFormat("italic"),
    list: listType === null ? null : listType === "number" ? "number" : "bullet",
    link: $nearestLink(anchor)?.getURL() ?? null,
  };
}

export function SnippetEditor({
  defaultValue,
  invalid,
  onChange,
  onSave,
}: {
  defaultValue: SnippetText;
  invalid: boolean;
  onChange: (text: SnippetText) => void;
  onSave: () => void;
}) {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: "snippet",
        nodes: snippetNodes,
        theme,
        editorState: () => $writeSnippetText(defaultValue),
        onError: (error) => {
          throw error;
        },
      }}
    >
      <div {...stylex.props(styles.box, invalid && styles.invalid)}>
        <Toolbar onSave={onSave} />
        <div {...stylex.props(styles.surface)}>
          <RichTextPlugin
            contentEditable={
              <Field.Control
                render={(props) => (
                  <ContentEditable
                    id={props.id}
                    aria-labelledby={props["aria-labelledby"]}
                    aria-describedby={props["aria-describedby"]}
                    aria-invalid={invalid || undefined}
                    data-invalid={invalid ? "" : undefined}
                    aria-multiline
                    spellCheck={false}
                    aria-placeholder="name@example.com"
                    placeholder={<div {...stylex.props(styles.placeholder)}>name@example.com</div>}
                    {...stylex.props(styles.content)}
                  />
                )}
              />
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
      </div>
      <HistoryPlugin />
      <ListPlugin />
      <LinkPlugin validateUrl={(url) => allowedHref(url) !== null} />
      <MarkdownShortcutPlugin
        transformers={[UNORDERED_LIST, ORDERED_LIST, BOLD_STAR, ITALIC_STAR, LINK]}
      />
      <OnChangePlugin
        ignoreSelectionChange
        onChange={(editorState) => onChange(editorState.read($readSnippetText))}
      />
      <SupportedFormatsOnly />
    </LexicalComposer>
  );
}

function SupportedFormatsOnly() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const unregister = [
      editor.registerCommand(
        FORMAT_TEXT_COMMAND,
        (format) => format !== "bold" && format !== "italic",
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(FORMAT_ELEMENT_COMMAND, () => true, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(INDENT_CONTENT_COMMAND, () => true, COMMAND_PRIORITY_CRITICAL),
      editor.registerNodeTransform(TextNode, (node) => {
        if ((node.getFormat() & ~KEPT_FORMATS) !== 0)
          node.setFormat(node.getFormat() & KEPT_FORMATS);
        if (node.getStyle() !== "") node.setStyle("");
      }),
      editor.registerNodeTransform(ParagraphNode, (node) => {
        if (node.getFormatType() !== "") node.setFormat("");
        if (node.getIndent() !== 0) node.setIndent(0);
      }),
      editor.registerNodeTransform(LinkNode, (node) => {
        if (allowedHref(node.getURL()) !== null) return;
        for (const child of node.getChildren()) node.insertBefore(child);
        node.remove();
      }),
    ];
    return () => {
      for (const off of unregister) off();
    };
  }, [editor]);
  return null;
}

type LinkRow = { url: string; selectionAtOpen: BaseSelection | null };

function Toolbar({ onSave }: { onSave: () => void }) {
  const [editor] = useLexicalComposerContext();
  const [formats, setFormats] = useState(NO_FORMATS);
  const [linkRow, setLinkRow] = useState<LinkRow | null>(null);

  const openLinkRow = () =>
    editor.read(() => {
      const selection = $getSelection();
      setLinkRow({ url: $readFormats().link ?? "", selectionAtOpen: selection?.clone() ?? null });
    });
  const save = useEffectEvent(onSave);
  const openLinkRowFromKey = useEffectEvent(openLinkRow);

  useEffect(() => {
    const unregister = [
      editor.registerUpdateListener(({ editorState }) =>
        setFormats(editorState.read($readFormats)),
      ),
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (!isShortcut(event)) return false;
          event.preventDefault();
          save();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_DOWN_COMMAND,
        (event) => {
          if (!isShortcut(event) || event.shiftKey || event.key.toLowerCase() !== "k") return false;
          event.preventDefault();
          openLinkRowFromKey();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    ];
    return () => {
      for (const off of unregister) off();
    };
  }, [editor]);

  const closeLinkRow = () => {
    setLinkRow(null);
    editor.focus();
  };

  const applyLink = (href: string | null) => {
    if (linkRow === null) return;
    editor.update(() => {
      $setSelection(linkRow.selectionAtOpen?.clone() ?? null);
      const selection = $getSelection();
      if (
        href !== null &&
        $isRangeSelection(selection) &&
        selection.isCollapsed() &&
        $nearestLink(selection.anchor.getNode()) === null
      ) {
        $insertNodes([$createLinkNode(href).append($createTextNode(href))]);
      } else {
        $toggleLink(href);
      }
    });
    closeLinkRow();
  };

  const href = linkRow === null ? null : hrefFromInput(linkRow.url);
  return (
    <>
      <div role="toolbar" aria-label="Formatting" {...stylex.props(styles.toolbar)}>
        <ToolButton
          label="Bold"
          shortcutKey="B"
          pressed={formats.bold}
          onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold")}
        >
          <BoldIcon size={16} />
        </ToolButton>
        <ToolButton
          label="Italic"
          shortcutKey="I"
          pressed={formats.italic}
          onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic")}
        >
          <ItalicIcon size={16} />
        </ToolButton>
        <span {...stylex.props(styles.divider)} />
        <ToolButton
          label="Bulleted list"
          pressed={formats.list === "bullet"}
          onClick={() =>
            editor.dispatchCommand(
              formats.list === "bullet" ? REMOVE_LIST_COMMAND : INSERT_UNORDERED_LIST_COMMAND,
              undefined,
            )
          }
        >
          <ListIcon size={16} />
        </ToolButton>
        <ToolButton
          label="Numbered list"
          pressed={formats.list === "number"}
          onClick={() =>
            editor.dispatchCommand(
              formats.list === "number" ? REMOVE_LIST_COMMAND : INSERT_ORDERED_LIST_COMMAND,
              undefined,
            )
          }
        >
          <ListOrderedIcon size={16} />
        </ToolButton>
        <span {...stylex.props(styles.divider)} />
        <ToolButton
          label="Link"
          shortcutKey="K"
          pressed={formats.link !== null || linkRow !== null}
          onClick={openLinkRow}
        >
          <LinkIcon size={16} />
        </ToolButton>
      </div>
      {linkRow !== null && (
        <div {...stylex.props(styles.linkRow)}>
          <input
            autoFocus
            aria-label="Link address"
            placeholder="https://example.com"
            value={linkRow.url}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setLinkRow({ ...linkRow, url: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                closeLinkRow();
              } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (href !== null) applyLink(href);
              }
            }}
            {...stylex.props(form.input, styles.linkInput)}
          />
          <Button variant="secondary" disabled={href === null} onClick={() => applyLink(href)}>
            Apply
          </Button>
          {formats.link !== null && (
            <Button variant="secondary" onClick={() => applyLink(null)}>
              Remove
            </Button>
          )}
        </div>
      )}
    </>
  );
}

const keepEditorFocus = (event: MouseEvent) => event.preventDefault();

function ToolButton({
  label,
  shortcutKey,
  pressed,
  onClick,
  children,
}: {
  label: string;
  shortcutKey?: string;
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="icon"
      aria-label={label}
      title={shortcutKey === undefined ? label : `${label} (${shortcut(shortcutKey)})`}
      pressed={pressed}
      onMouseDown={keepEditorFocus}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

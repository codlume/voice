import { $generateNodesFromDOM } from "@lexical/html";
import { $isLinkNode, LinkNode } from "@lexical/link";
import { $isListItemNode, $isListNode, ListItemNode, ListNode } from "@lexical/list";
import {
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  type ElementNode,
  type Klass,
  type LexicalNode,
} from "lexical";

import { allowedHref, escapeHtml } from "../shared/snippet-html.ts";
import type { Snippet } from "../shared/snippets.ts";

export type SnippetText = Pick<Snippet, "expansion" | "expansionHtml">;

export const snippetNodes: readonly Klass<LexicalNode>[] = [ListNode, ListItemNode, LinkNode];

// A link as typed or pasted: a stored scheme, or an address or domain that gets one. A relative
// link ("/docs", "#top") has no page to resolve against and gets none.
export function hrefFromInput(input: string): string | null {
  const href = allowedHref(input);
  if (href !== null) return href;
  const trimmed = input.trim();
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) || !/^[\p{L}\p{N}]/u.test(trimmed)) return null;
  if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(trimmed)) return allowedHref(`mailto:${trimmed}`);
  return allowedHref(`https://${trimmed}`);
}

// What the editor shows is what is saved, so a link gets the href the serializer would write,
// and a link with none stops being a link.
export function $storedLink(link: LinkNode): void {
  const href = hrefFromInput(link.getURL());
  if (href === null) {
    for (const child of link.getChildren()) link.insertBefore(child);
    link.remove();
  } else if (href !== link.getURL()) {
    link.setURL(href);
  }
}

// Saved lists are bulleted or number from 1, and have one level, so the editor shows them that
// way: a pasted task list loses its checkboxes, and an indented item moves out to follow its parent.
export function $storedList(list: ListNode): void {
  if (list.getListType() === "check") list.setListType("bullet");
  if (list.getStart() !== 1) list.setStart(1);
  const item = list.getParent();
  if (!$isListItemNode(item)) return;
  let last: LexicalNode = item;
  for (const nested of item.getChildren().filter($isListNode)) {
    for (const child of nested.getChildren()) last = last.insertAfter(child);
    nested.remove();
  }
  if (item.isEmpty()) item.remove();
}

type Written = { html: string; text: string; formatted: boolean };

function writeInline(nodes: readonly LexicalNode[]): Written {
  let html = "";
  let text = "";
  let formatted = false;
  for (const node of nodes) {
    if ($isLineBreakNode(node)) {
      html += "<br>";
      text += "\n";
    } else if ($isTextNode(node)) {
      let inner = escapeHtml(node.getTextContent());
      if (node.hasFormat("italic")) inner = `<em>${inner}</em>`;
      if (node.hasFormat("bold")) inner = `<strong>${inner}</strong>`;
      formatted ||= node.hasFormat("bold") || node.hasFormat("italic");
      html += inner;
      text += node.getTextContent();
    } else if ($isElementNode(node)) {
      const inner = writeInline(node.getChildren());
      const href = $isLinkNode(node) ? allowedHref(node.getURL()) : null;
      formatted ||= inner.formatted;
      if (href === null || inner.text === "") {
        html += inner.html;
        text += inner.text;
        continue;
      }
      formatted = true;
      html += `<a href="${escapeHtml(href)}">${inner.html}</a>`;
      const shown = href.startsWith("mailto:") ? href.slice("mailto:".length) : href;
      text += inner.text === shown ? shown : `${inner.text} (${shown})`;
    }
  }
  return { html, text, formatted };
}

// A <br> that ends a block, or is its only content, does not render a line, and Lexical drops it
// on import. One more keeps empty lines visible in the target and the round trip stable.
function writeBlockContent(block: ElementNode): Written {
  const children = block.getChildren();
  const written = writeInline(children);
  const last = children.at(-1);
  if (last === undefined || $isLineBreakNode(last)) written.html += "<br>";
  return written;
}

export function $readSnippetText(): SnippetText {
  const html: string[] = [];
  const lines: string[] = [];
  let formatted = false;
  for (const block of $getRoot().getChildren()) {
    if ($isListNode(block)) {
      formatted = true;
      const tag = block.getListType() === "number" ? "ol" : "ul";
      // $storedList keeps every list one level deep, so each item is one line.
      const items = block
        .getChildren()
        .filter($isListItemNode)
        .map((item, index) => {
          const written = writeBlockContent(item);
          formatted ||= written.formatted;
          lines.push(`${tag === "ol" ? `${index + 1}.` : "-"} ${written.text}`);
          return `<li>${written.html}</li>`;
        });
      html.push(`<${tag}>${items.join("")}</${tag}>`);
    } else if ($isElementNode(block)) {
      const written = writeBlockContent(block);
      formatted ||= written.formatted;
      lines.push(written.text);
      html.push(`<p>${written.html}</p>`);
    }
  }
  return { expansion: lines.join("\n"), expansionHtml: formatted ? html.join("") : null };
}

export function $writeSnippetText({ expansion, expansionHtml }: SnippetText): void {
  const root = $getRoot();
  root.clear();
  if (expansionHtml === null) {
    for (const line of expansion.split(/\r?\n/)) {
      const paragraph = $createParagraphNode();
      if (line !== "") paragraph.append($createTextNode(line));
      root.append(paragraph);
    }
    return;
  }
  const dom = new DOMParser().parseFromString(expansionHtml, "text/html");
  // Import collapses runs of spaces unless an ancestor is pre-wrap; stored text keeps them as typed.
  dom.body.style.whiteSpace = "pre-wrap";
  let paragraph: ElementNode | null = null;
  for (const node of $generateNodesFromDOM($getEditor(), dom)) {
    if ($isElementNode(node) && !node.isInline()) {
      root.append(node);
      paragraph = null;
    } else {
      if (paragraph === null) root.append((paragraph = $createParagraphNode()));
      paragraph.append(node);
    }
  }
  if (root.getChildrenSize() === 0) root.append($createParagraphNode());
}

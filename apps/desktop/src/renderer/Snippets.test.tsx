// @vitest-environment happy-dom
import { $getRoot, $getSelection, $isRangeSelection, getNearestEditorFromDOMNode } from "lexical";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { HubApi } from "../shared/api.ts";
import type { DictionaryEntry } from "../shared/dictionary.ts";
import type { Snippet } from "../shared/snippets.ts";
import { Snippets } from "./Snippets.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// These pin the roles, names and stored effects that users and the verify recipes in
// .claude/skills/verify/features/snippets.md depend on, so a restyle cannot break them silently.

const EMAIL: Snippet = {
  id: "email",
  trigger: "my email",
  expansion: "ada@example.com",
  expansionHtml: null,
  enabled: true,
};
const ADDRESS: Snippet = {
  id: "address",
  trigger: "my address",
  expansion: "1 Analytical Way",
  expansionHtml: null,
  enabled: false,
};

let root: Root;
let host: HTMLElement;
const updateSettings = vi.fn<HubApi["updateSettings"]>(async () => {});

beforeEach(() => {
  updateSettings.mockClear();
  (window as { voice?: HubApi }).voice = {
    getSnapshot: vi.fn(),
    updateSettings,
  } as Partial<HubApi> as HubApi;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.replaceChildren();
});

// Text a screen reader announces: skips aria-hidden subtrees such as decorative icons.
function visibleText(node: Node): string {
  if (node instanceof Element && node.getAttribute("aria-hidden") === "true") return "";
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  return [...node.childNodes].map(visibleText).join("");
}

const textOfIds = (ids: string | null) =>
  (ids ?? "")
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ")
    .trim();

function nameOf(el: Element): string {
  const label = el.getAttribute("aria-label");
  if (label) return label;
  const by = el.getAttribute("aria-labelledby");
  if (by) return textOfIds(by);
  if (el.id) {
    const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (forLabel) return forLabel.textContent?.trim() ?? "";
  }
  return visibleText(el).trim();
}

const IMPLICIT_ROLES: Record<string, string> = {
  button: "button:not([role])",
  heading: "h1, h2, h3",
};

const allByRole = (role: string) => [
  ...document.querySelectorAll(
    [`[role="${role}"]`, IMPLICIT_ROLES[role]].filter(Boolean).join(", "),
  ),
];

function byRole(role: string, name: string): HTMLElement {
  const matches = allByRole(role).filter((el) => nameOf(el) === name);
  if (matches.length !== 1) {
    throw new Error(`expected one ${role} named "${name}", found ${matches.length}`);
  }
  return matches[0] as HTMLElement;
}

async function renderSnippets(
  snippets: readonly Snippet[] = [],
  dictionary: readonly DictionaryEntry[] = [],
) {
  await act(async () => root.render(<Snippets snippets={snippets} dictionary={dictionary} />));
}

async function click(el: HTMLElement) {
  await act(async () => el.click());
}

// React tracks a controlled field's value, so set it through the native setter before the event.
async function type(el: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// The Expansion editor loads lazily; wait for its contenteditable to mount.
async function expansionEditor(dialog: HTMLElement) {
  await act(async () => {
    await import("./SnippetEditor.tsx");
  });
  return vi.waitFor(() => {
    const editable = dialog.querySelector<HTMLElement>("[contenteditable]");
    if (!editable) throw new Error("the Expansion editor has not mounted");
    return editable;
  });
}

// Inserts text at the end of the editor, the way a paste lands, through Lexical's own selection.
async function typeExpansion(editable: HTMLElement, text: string) {
  const editor = getNearestEditorFromDOMNode(editable);
  if (!editor) throw new Error("the Expansion field is not a Lexical editor");
  await act(async () => {
    editor.update(
      () => {
        $getRoot().selectEnd();
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText(text);
      },
      { discrete: true },
    );
  });
}

const triggerInput = (dialog: HTMLElement) => {
  const inputs = [...dialog.querySelectorAll("input")].filter((el) => nameOf(el) === "Trigger");
  if (inputs.length !== 1) throw new Error(`expected one Trigger input, found ${inputs.length}`);
  return inputs[0] as HTMLInputElement;
};

async function openAdd() {
  await click(byRole("button", "Add new"));
  return byRole("dialog", "Add snippet");
}

test("the page is headed Snippets and shows the my email example when empty", async () => {
  await renderSnippets();

  byRole("heading", "Snippets");
  expect(document.body.textContent).toContain("my email");
  expect(allByRole("button").filter((el) => nameOf(el).startsWith("Edit "))).toEqual([]);
});

test("each snippet has Edit and Delete buttons named after its trigger", async () => {
  await renderSnippets([EMAIL, ADDRESS]);

  for (const trigger of ["my email", "my address"]) {
    byRole("button", `Edit ${trigger}`);
    byRole("button", `Delete ${trigger}`);
  }
  expect(document.body.textContent).toContain("ada@example.com");
});

test("a switched-off snippet shows Off, and its Edit button is described by it", async () => {
  await renderSnippets([EMAIL, ADDRESS]);

  expect(textOfIds(byRole("button", "Edit my address").getAttribute("aria-describedby"))).toBe(
    "Off",
  );
  expect(byRole("button", "Edit my email").getAttribute("aria-describedby")).toBeNull();
});

test("Add new opens the Add snippet dialog with an empty Trigger", async () => {
  await renderSnippets();
  const dialog = await openAdd();

  expect(triggerInput(dialog).value).toBe("");
  byRole("switch", "Enabled");
});

test("saving with an empty trigger stores nothing and marks Trigger invalid", async () => {
  await renderSnippets();
  const dialog = await openAdd();
  await click(byRole("button", "Add snippet"));

  expect(updateSettings).not.toHaveBeenCalled();
  expect(byRole("dialog", "Add snippet")).toBe(dialog);
  expect(triggerInput(dialog).getAttribute("aria-invalid")).toBe("true");
  expect(dialog.textContent).toContain("Enter a trigger phrase.");
});

test("a valid add stores the trimmed trigger as an enabled snippet", async () => {
  await renderSnippets();
  const dialog = await openAdd();
  await type(triggerInput(dialog), "  my email  ");
  await typeExpansion(await expansionEditor(dialog), "name@example.com");
  await click(byRole("button", "Add snippet"));

  expect(updateSettings).toHaveBeenCalledWith({
    snippets: [
      {
        id: expect.any(String),
        trigger: "my email",
        expansion: "name@example.com",
        expansionHtml: null,
        enabled: true,
      },
    ],
  });
});

test("the Expansion toolbar has unpressed formatting buttons", async () => {
  await renderSnippets();
  await expansionEditor(await openAdd());

  const toolbar = byRole("toolbar", "Formatting");
  const buttons = [...toolbar.querySelectorAll("button")];
  expect(buttons.map(nameOf)).toEqual(["Bold", "Italic", "Bulleted list", "Numbered list", "Link"]);
  for (const button of buttons) expect(button.getAttribute("aria-pressed")).toBe("false");
});

test("Delete asks first, then removes only that snippet", async () => {
  await renderSnippets([EMAIL, ADDRESS]);
  await click(byRole("button", "Delete my email"));

  const confirm = byRole("alertdialog", "Delete snippet?");
  expect(confirm.textContent).toContain("‘my email’ will be deleted permanently.");
  expect(updateSettings).not.toHaveBeenCalled();

  await click(byRole("button", "Delete"));
  expect(updateSettings).toHaveBeenCalledWith({ snippets: [ADDRESS] });
});

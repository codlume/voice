// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { HubApi } from "../shared/api.ts";
import type { DictionaryEntry } from "../shared/dictionary.ts";
import type { Snippet } from "../shared/snippets.ts";
import { Dictionary } from "./Dictionary.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// These pin the roles, names and stored effects that users and the verify recipes in
// .claude/skills/verify/features/dictionary.md depend on, so a restyle cannot break them silently.

const WORD: DictionaryEntry = { id: "word", phrase: "Worcestershire", replacement: null };
const BTW: DictionaryEntry = { id: "btw", phrase: "btw", replacement: "by the way" };

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

// Text inputs only: the switch carries a hidden checkbox input of its own.
const inputsIn = (dialog: HTMLElement) => [
  ...dialog.querySelectorAll<HTMLInputElement>(
    'input:not([type="checkbox"], [type="hidden"], [aria-hidden="true"])',
  ),
];

function inputByLabel(dialog: HTMLElement, name: string): HTMLInputElement {
  const inputs = inputsIn(dialog).filter((el) => nameOf(el) === name);
  if (inputs.length !== 1) throw new Error(`expected one input "${name}", found ${inputs.length}`);
  return inputs[0] as HTMLInputElement;
}

async function renderDictionary(
  dictionary: readonly DictionaryEntry[] = [],
  snippets: readonly Snippet[] = [],
) {
  await act(async () => root.render(<Dictionary dictionary={dictionary} snippets={snippets} />));
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

async function openAdd() {
  await click(byRole("button", "Add new"));
  return byRole("dialog", "Add to dictionary");
}

test("the page is headed Dictionary and shows the Worcestershire example when empty", async () => {
  await renderDictionary();

  byRole("heading", "Dictionary");
  expect(document.body.textContent).toContain("Worcestershire");
  expect(allByRole("button").filter((el) => nameOf(el).startsWith("Edit "))).toEqual([]);
});

test("a word and a replacement each get a row with Edit and Delete named after the phrase", async () => {
  await renderDictionary([WORD, BTW]);

  expect(document.body.textContent).toContain("btw → by the way");
  for (const phrase of ["Worcestershire", "btw"]) {
    byRole("button", `Edit ${phrase}`);
    byRole("button", `Delete ${phrase}`);
  }
});

test("Add new opens Add to dictionary with one word input and the replace switch off", async () => {
  await renderDictionary();
  const dialog = await openAdd();

  expect(inputsIn(dialog).map(nameOf)).toEqual(["Word or phrase"]);
  expect(byRole("switch", "Replace with other text").getAttribute("aria-checked")).toBe("false");
});

test("saving an empty word stores nothing and marks the word input invalid", async () => {
  await renderDictionary();
  const dialog = await openAdd();
  await click(byRole("button", "Add to dictionary"));

  expect(updateSettings).not.toHaveBeenCalled();
  expect(byRole("dialog", "Add to dictionary")).toBe(dialog);
  const word = inputByLabel(dialog, "Word or phrase");
  expect(word.getAttribute("aria-invalid")).toBe("true");
  expect(dialog.textContent).toContain("Enter a word or phrase.");
});

test("Replace with other text splits the row into Phrase and Replace with, keeping the phrase", async () => {
  await renderDictionary();
  const dialog = await openAdd();
  await type(inputByLabel(dialog, "Word or phrase"), "btw");
  await click(byRole("switch", "Replace with other text"));

  expect(inputsIn(dialog).map(nameOf)).toEqual(["Phrase", "Replace with"]);
  expect(inputByLabel(dialog, "Phrase").value).toBe("btw");
});

test("a valid add stores the trimmed word with no replacement", async () => {
  await renderDictionary();
  const dialog = await openAdd();
  await type(inputByLabel(dialog, "Word or phrase"), "  Worcestershire ");
  await click(byRole("button", "Add to dictionary"));

  expect(updateSettings).toHaveBeenCalledWith({
    dictionary: [{ id: expect.any(String), phrase: "Worcestershire", replacement: null }],
  });
});

test("a valid replacement add stores the phrase and its replacement", async () => {
  await renderDictionary([WORD]);
  const dialog = await openAdd();
  await click(byRole("switch", "Replace with other text"));
  await type(inputByLabel(dialog, "Phrase"), "btw");
  await type(inputByLabel(dialog, "Replace with"), "by the way");
  await click(byRole("button", "Add to dictionary"));

  expect(updateSettings).toHaveBeenCalledWith({
    dictionary: [WORD, { id: expect.any(String), phrase: "btw", replacement: "by the way" }],
  });
});

test("Delete asks first, then removes only that entry", async () => {
  await renderDictionary([WORD, BTW]);
  await click(byRole("button", "Delete btw"));

  const confirm = byRole("alertdialog", "Delete from dictionary?");
  expect(confirm.textContent).toContain("‘btw’ will be deleted permanently.");
  expect(updateSettings).not.toHaveBeenCalled();

  await click(byRole("button", "Delete"));
  expect(updateSettings).toHaveBeenCalledWith({ dictionary: [WORD] });
});

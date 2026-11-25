// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { DEFAULT_SETTINGS, type HubApi, type ModelStatus, type Settings } from "../shared/api.ts";
import { BUILT_IN_TRANSFORMS } from "../shared/transforms.ts";
import { Transforms } from "./Transforms.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// These pin the roles, names and stored effects that users and the verify recipes in
// .claude/skills/verify/features/transforms.md depend on, so a restyle cannot break them silently.

const [POLISH, PROMPT_ENGINEER] = BUILT_IN_TRANSFORMS as [
  (typeof BUILT_IN_TRANSFORMS)[number],
  (typeof BUILT_IN_TRANSFORMS)[number],
];

let root: Root;
let host: HTMLElement;
const updateSettings = vi.fn<HubApi["updateSettings"]>(async () => {});

beforeEach(() => {
  updateSettings.mockClear();
  (window as { voice?: HubApi }).voice = {
    getSnapshot: vi.fn(),
    updateSettings,
    getLastTransform: vi.fn(async () => null),
    onLastTransform: vi.fn(() => () => {}),
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

const IMPLICIT_ROLES: Record<string, string> = { button: "button:not([role])" };

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

function fieldByLabel(name: string): HTMLInputElement | HTMLTextAreaElement {
  const fields = [...document.querySelectorAll("input, textarea")].filter(
    (el) => nameOf(el) === name,
  );
  if (fields.length !== 1) {
    throw new Error(`expected one field labelled "${name}", found ${fields.length}`);
  }
  return fields[0] as HTMLInputElement | HTMLTextAreaElement;
}

const isInvalid = (el: Element) =>
  el.getAttribute("aria-invalid") === "true" || el.hasAttribute("data-invalid");

async function renderTransforms(
  settings: Settings = DEFAULT_SETTINGS,
  model: ModelStatus = { state: "installed" },
) {
  await act(async () =>
    root.render(<Transforms settings={settings} model={model} onOpenModels={() => {}} />),
  );
}

async function click(el: HTMLElement) {
  await act(async () => el.click());
}

// React tracks a controlled field's value, so set it through the native setter before the event.
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = Object.getPrototypeOf(el) as object;
  const setValue = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    setValue?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openPolish() {
  await renderTransforms();
  await click(byRole("button", "Edit Polish"));
  return byRole("dialog", "Edit transform");
}

test("each transform is one Edit button in a list, with its name, first line and shortcut", async () => {
  await renderTransforms({
    ...DEFAULT_SETTINGS,
    transforms: {
      ...DEFAULT_SETTINGS.transforms,
      items: [POLISH, { ...PROMPT_ENGINEER, shortcut: null }],
    },
  });

  const rows = [...document.querySelectorAll("ul > li")];
  expect(rows).toHaveLength(2);
  const buttons = rows.map((row) => row.querySelector("button"));
  expect(buttons.map((button) => button && nameOf(button))).toEqual([
    "Edit Polish",
    "Edit Prompt Engineer",
  ]);

  const [polish, promptEngineer] = buttons as [HTMLButtonElement, HTMLButtonElement];
  expect(polish.textContent).toContain("Polish");
  expect(polish.textContent).toContain(POLISH.instruction.split("\n")[0]);
  expect([...polish.querySelectorAll("kbd kbd")].map((key) => key.textContent)).toEqual(["⌥", "1"]);
  expect(promptEngineer.textContent).toContain("Prompt Engineer");
  expect(promptEngineer.textContent).toContain("No shortcut");
  expect(promptEngineer.querySelector("kbd")).toBeNull();
});

test("Edit Polish opens Edit transform with the name and a live counter described on it", async () => {
  await openPolish();
  const name = fieldByLabel("Name");
  expect(name.value).toBe("Polish");
  expect(textOfIds(name.getAttribute("aria-describedby"))).toContain("6/40");

  await type(name, "Polished");
  expect(fieldByLabel("Name").value).toBe("Polished");
  expect(textOfIds(fieldByLabel("Name").getAttribute("aria-describedby"))).toContain("8/40");
});

test("saving with an empty name stores nothing and focuses the invalid Name field", async () => {
  await openPolish();
  await type(fieldByLabel("Name"), "");
  await click(byRole("button", "Save changes"));

  expect(updateSettings).not.toHaveBeenCalled();
  const name = fieldByLabel("Name");
  expect(isInvalid(name)).toBe(true);
  expect(document.activeElement).toBe(name);
  expect(document.body.textContent).toContain("Enter a name.");
});

test("Save changes stores the edited instruction in place", async () => {
  await openPolish();
  await type(fieldByLabel("Instruction"), "Make it shorter.");
  await click(byRole("button", "Save changes"));

  expect(updateSettings).toHaveBeenCalledWith({
    transforms: { items: [{ ...POLISH, instruction: "Make it shorter." }, PROMPT_ENGINEER] },
  });
});

test("Delete transform asks first, then removes Polish", async () => {
  await openPolish();
  const remove = byRole("button", "Delete transform");
  expect(remove.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");

  await click(remove);
  byRole("alertdialog", "Delete transform?");
  expect(updateSettings).not.toHaveBeenCalled();

  await click(byRole("button", "Delete"));
  expect(updateSettings).toHaveBeenCalledWith({ transforms: { items: [PROMPT_ENGINEER] } });
});

test("Create opens Create transform with an empty name", async () => {
  await renderTransforms();
  await click(byRole("button", "Create"));

  byRole("dialog", "Create transform");
  expect(fieldByLabel("Name").value).toBe("");
  expect(fieldByLabel("Instruction").value).toBe("");
});

test("turning Transforms on asks to download a missing model and stores nothing yet", async () => {
  await renderTransforms(DEFAULT_SETTINGS, { state: "missing" });
  await click(byRole("switch", "Transforms"));

  const confirm = allByRole("alertdialog").map(nameOf);
  expect(confirm).toHaveLength(1);
  expect(confirm[0]).toMatch(/^Download the .+ transform model\?$/);
  expect(updateSettings).not.toHaveBeenCalled();
});

test("turning Transforms on with the model installed stores enabled", async () => {
  await renderTransforms(DEFAULT_SETTINGS, { state: "installed" });
  await click(byRole("switch", "Transforms"));

  expect(updateSettings).toHaveBeenCalledWith({ transforms: { enabled: true } });
});

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { DEFAULT_SETTINGS, type HubApi, type InstalledApp, type Settings } from "../shared/api.ts";
import { parseBundleId, type BundleId } from "../shared/app-categories.ts";
import { Style } from "./Style.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// These pin the roles, names and stored effects that users and the verify recipes in
// .claude/skills/verify/features/style.md depend on, so a restyle cannot break them silently.

const bundleId = (id: string): BundleId => {
  const parsed = parseBundleId(id);
  if (parsed === null) throw new Error(`bad bundle id ${id}`);
  return parsed;
};

const TEXTEDIT = bundleId("com.apple.textedit");
const APPS: InstalledApp[] = [
  { bundleId: TEXTEDIT, name: "TextEdit", browser: false },
  { bundleId: bundleId("com.apple.Notes"), name: "Notes", browser: false },
];

let root: Root;
let host: HTMLElement;
const updateSettings = vi.fn<HubApi["updateSettings"]>(async () => {});
const editAssignments = vi.fn<HubApi["editAssignments"]>(async () => {});

beforeEach(() => {
  updateSettings.mockClear();
  editAssignments.mockClear();
  (window as { voice?: HubApi }).voice = {
    getSnapshot: vi.fn(),
    getInstalledApps: vi.fn(async () => APPS),
    getAppIcons: vi.fn(async () => ({})),
    updateSettings,
    editAssignments,
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

// Text a screen reader announces: skips aria-hidden subtrees such as decorative icon letters.
function visibleText(node: Node): string {
  if (node instanceof Element && node.getAttribute("aria-hidden") === "true") return "";
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  return [...node.childNodes].map(visibleText).join("");
}

function nameOf(el: Element): string {
  const label = el.getAttribute("aria-label");
  if (label) return label;
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    return by
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  }
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

const isDisabled = (el: Element) =>
  el.matches(":disabled") || el.getAttribute("aria-disabled") === "true";

async function renderStyle(settings: Settings = DEFAULT_SETTINGS) {
  await act(async () => root.render(<Style settings={settings} />));
}

async function click(el: HTMLElement) {
  await act(async () => el.click());
}

const cleanupOff: Settings = {
  ...DEFAULT_SETTINGS,
  cleanup: { ...DEFAULT_SETTINGS.cleanup, enabled: false },
};

function expectCardsDisabled() {
  expect(document.querySelector("fieldset")?.disabled).toBe(true);
  const radios = allByRole("radio");
  expect(radios).toHaveLength(3);
  for (const radio of radios) expect(isDisabled(radio)).toBe(true);
}

test("four category tabs start on Personal and switch to Work with its banner", async () => {
  await renderStyle();
  expect(allByRole("tab").map(nameOf)).toEqual([
    "Personal messages",
    "Work messages",
    "Email",
    "Other",
  ]);
  expect(byRole("tab", "Personal messages").getAttribute("aria-selected")).toBe("true");

  await click(byRole("tab", "Work messages"));

  expect(byRole("tab", "Work messages").getAttribute("aria-selected")).toBe("true");
  expect(byRole("tab", "Personal messages").getAttribute("aria-selected")).toBe("false");
  expect(document.body.textContent).toContain("This style applies in workplace messengers");
});

test("picking a style saves it for the active tab's category only", async () => {
  await renderStyle();
  expect(allByRole("radio").map(nameOf)).toEqual(["Formal", "Casual", "Very casual"]);

  await click(byRole("radio", "Very casual"));
  expect(updateSettings).toHaveBeenLastCalledWith({
    cleanup: { styles: { personal: "veryCasual" } },
  });

  await click(byRole("tab", "Email"));
  expect(allByRole("radio").map(nameOf)).toEqual(["Formal", "Casual", "Very casual"]);
  await click(byRole("radio", "Casual"));
  expect(updateSettings).toHaveBeenLastCalledWith({ cleanup: { styles: { email: "casual" } } });
});

test("with cleanup off the style cards are disabled on every tab and the page says why", async () => {
  await renderStyle(cleanupOff);
  expectCardsDisabled();
  expect(document.body.textContent).toContain(
    "Turn on cleanup to apply a style. Your transcript is currently inserted as recognized.",
  );

  await click(byRole("tab", "Work messages"));
  expectCardsDisabled();
  await click(byRole("radio", "Casual"));
  expect(updateSettings).not.toHaveBeenCalled();
});

test("the cleanup switch is named Clean up text and turns cleanup off", async () => {
  await renderStyle();
  const toggle = byRole("switch", "Clean up text");
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await click(toggle);
  expect(updateSettings).toHaveBeenLastCalledWith({ cleanup: { enabled: false } });
});

test("the + picker lists installed apps and assigns the picked one to the category", async () => {
  await renderStyle();
  await click(byRole("button", "Add an app or website to Personal messages"));

  const dialog = byRole("dialog", "Add to Personal messages");
  const search = dialog.querySelector<HTMLElement>('[role="combobox"]');
  expect(search).not.toBeNull();
  expect(document.activeElement).toBe(search);
  expect(dialog.querySelector('[placeholder="slack.com or a link"]')).not.toBeNull();
  expect(allByRole("option").map(nameOf)).toEqual(["Notes", "TextEdit"]);

  await click(byRole("option", "TextEdit"));
  expect(editAssignments).toHaveBeenCalledWith({
    op: "place",
    assignment: { kind: "app", bundleId: TEXTEDIT, name: "TextEdit", category: "personal" },
  });
});

test("a chip's remove button sends its assignment back", async () => {
  const assignment = {
    kind: "app",
    bundleId: TEXTEDIT,
    name: "TextEdit",
    category: "personal",
  } as const;
  await renderStyle({
    ...DEFAULT_SETTINGS,
    cleanup: { ...DEFAULT_SETTINGS.cleanup, assignments: [assignment] },
  });

  await click(byRole("button", "Remove TextEdit from Personal messages"));
  expect(editAssignments).toHaveBeenCalledWith({ op: "unassign", assignment });
});

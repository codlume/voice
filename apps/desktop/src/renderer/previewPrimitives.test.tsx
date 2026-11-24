// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import { PrimitivePreview, uiScenes } from "./previewPrimitives.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

function show(scene: string) {
  act(() => root.render(<PrimitivePreview scene={scene} />));
}

test.each(Object.keys(uiScenes))("the %s scene renders", (scene) => {
  show(scene);
  expect(host.querySelector(`section[aria-label="${scene}"]`)?.childElementCount).toBeGreaterThan(
    0,
  );
});

test("the input scene marks the invalid field", () => {
  show("input");
  const fields = [...host.querySelectorAll("input")];
  expect(fields).toHaveLength(4);
  expect(fields.map((field) => field.getAttribute("aria-invalid"))).toEqual([
    null,
    "true",
    null,
    null,
  ]);
});

test("the menu scene opens on its items", async () => {
  show("menu");
  await act(async () => {});
  const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
  expect(items).toEqual(["Edit profile", "Upgrade", "Sign out"]);
});

test("the toggles scene switches segments and switches", () => {
  show("toggles");
  const work = [...host.querySelectorAll("button")].find((b) => b.textContent === "Work messages");
  act(() => work?.click());
  expect(work?.getAttribute("aria-pressed")).toBe("true");
  const toggle = host.querySelector<HTMLElement>("#preview-switch");
  expect(toggle?.getAttribute("aria-checked")).toBe("true");
  act(() => toggle?.click());
  expect(toggle?.getAttribute("aria-checked")).toBe("false");
});

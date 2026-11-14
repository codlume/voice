// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { DEFAULT_SETTINGS, type HubApi } from "../shared/api.ts";
import { Style } from "./Style.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
const getInstalledApps = vi.fn<HubApi["getInstalledApps"]>();

beforeEach(() => {
  getInstalledApps.mockReset();
  (window as { voice?: HubApi }).voice = {
    getSnapshot: vi.fn(),
    getInstalledApps,
    getAppIcons: vi.fn(async () => ({})),
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

test("the app picker says the list failed to load instead of claiming there are no apps", async () => {
  getInstalledApps.mockRejectedValueOnce(new Error("Helper is restarting."));
  await act(async () => root.render(<Style settings={DEFAULT_SETTINGS} />));
  const add = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Add an app or website to Personal messages"]',
  );
  await act(async () => add?.click());
  const picker =
    document.querySelector('[aria-label="Add to Personal messages"]')?.textContent ?? "";
  expect(picker).not.toContain("No apps found");
  expect(picker).toContain("Could not list your apps");
});

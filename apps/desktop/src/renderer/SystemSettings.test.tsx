// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { DEFAULT_SETTINGS } from "../shared/api.ts";
import { SystemSettings } from "./SystemSettings.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function deferred() {
  return Promise.withResolvers<void>();
}

async function renderWithSave(save: Promise<void>) {
  const updateSettings = vi.fn(() => save);
  (window as unknown as { voice: unknown }).voice = { getSnapshot: vi.fn(), updateSettings };
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <SystemSettings settings={{ ...DEFAULT_SETTINGS, theme: "dark" }} loginItem="unavailable" />,
    ),
  );
  return { host, updateSettings };
}

const radio = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll<HTMLElement>('[role="radio"]')].find((el) => el.textContent === name);

const painted = () =>
  act(async () => {
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
  });

const switching = () => document.documentElement.classList.contains("theme-switching");

afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  document.documentElement.classList.remove("theme-switching");
});

describe("theme", () => {
  test("transitions stay off from the click until the new theme has painted", async () => {
    const save = deferred();
    const { host, updateSettings } = await renderWithSave(save.promise);

    await act(async () => radio(host, "Light")?.click());
    expect(updateSettings).toHaveBeenCalledWith({ theme: "light" });
    expect(switching()).toBe(true);

    await act(async () => save.resolve());
    await painted();
    expect(switching()).toBe(false);
  });

  test("a failed save turns transitions back on and reports the error", async () => {
    const save = deferred();
    const { host } = await renderWithSave(save.promise);

    await act(async () => radio(host, "System")?.click());
    await act(async () => save.reject(new Error("disk full")));
    await painted();
    expect(switching()).toBe(false);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });
});

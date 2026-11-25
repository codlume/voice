// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { AccountState } from "../shared/api.ts";
import { AccountSettings } from "./Account.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

const ada = {
  name: "Ada Lovelace",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
};

async function render(account: AccountState) {
  const api = {
    getSnapshot: vi.fn(),
    signIn: vi.fn(async () => {}),
    submitSignInCode: vi.fn(async () => {}),
    updateAccountName: vi.fn(async () => {}),
  };
  (window as unknown as { voice: unknown }).voice = api;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<AccountSettings account={account} />));
  return { host, api };
}

const button = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => (el.getAttribute("aria-label") ?? el.textContent?.trim()) === name,
  );

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

describe("account settings", () => {
  test("unavailable accounts show the reason and no way to sign in", async () => {
    const { host } = await render({ kind: "unavailable", reason: "Set VOICE_API_URL to sign in." });

    expect(host.querySelector("h2")?.textContent).toBe("Accounts are unavailable");
    expect(host.textContent).toContain("Set VOICE_API_URL to sign in.");
    expect(host.querySelector("#setting-sign-in")).toBeNull();
    expect(host.querySelector("button")).toBeNull();
  });

  test("signed out offers Google sign-in", async () => {
    const { host, api } = await render({ kind: "signedOut" });

    const signIn = host.querySelector<HTMLButtonElement>("#setting-sign-in");
    expect(signIn?.textContent).toBe("Sign in with Google");
    await act(async () => signIn?.click());
    expect(api.signIn).toHaveBeenCalledOnce();
  });

  test("a pasted code is sent with Enter", async () => {
    const { host, api } = await render({ kind: "signingIn", purpose: "signIn", phase: "browser" });
    expect(host.querySelector("#setting-sign-in-code")).toBeNull();

    await act(async () => button(host, "Paste a code instead")?.click());
    const code = host.querySelector<HTMLInputElement>("#setting-sign-in-code");
    expect(code?.getAttribute("aria-label")).toBe("Sign-in code");
    expect(document.activeElement).toBe(code);

    await type(code!, "  the-code-from-the-browser  ");
    await act(async () =>
      code?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(api.submitSignInCode).toHaveBeenCalledWith("the-code-from-the-browser");
  });

  test("signed in shows the name, keeps the email hidden, and saves an edited name", async () => {
    const { host, api } = await render({ kind: "signedIn", ...ada });

    expect(host.textContent).toContain("Ada Lovelace");
    expect(host.textContent).not.toContain("ada@example.com");
    for (const id of ["first-name", "last-name", "save-name", "sign-out", "delete-account"])
      expect(host.querySelector(`#setting-${id}`), id).not.toBeNull();
    expect(button(host, "Delete account")?.id).toBe("setting-delete-account");

    await act(async () => button(host, "Show email")?.click());
    expect(host.textContent).toContain("ada@example.com");

    const save = host.querySelector<HTMLButtonElement>("#setting-save-name")!;
    expect(save.disabled).toBe(true);
    await type(host.querySelector<HTMLInputElement>("#setting-first-name")!, " Augusta ");
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(api.updateAccountName).toHaveBeenCalledWith({
      firstName: "Augusta",
      lastName: "Lovelace",
    });
  });
});

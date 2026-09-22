import { test, expect } from "@playwright/test";

test("production CSS and simulated preload save a preference and report a failed save", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let settings = { appearance: "light" as "light" | "dark" };
    let writes = 0;
    window.voice = {
      onChanged: () => () => {},
      command: async (command) => {
        if (command.type === "settings.set") {
          writes += 1;
          if (writes === 2) return { ok: false, error: "storage-unavailable" };
          settings = { appearance: command.appearance };
        }
        return {
          ok: true,
          settings,
          status: {
            storage: "ready",
            helper: "ready",
            capture: "unavailable",
            shortcuts: "unavailable",
          },
        };
      },
    };
  });
  await page.goto("/");
  await expect(page.getByRole("main")).toHaveCSS("background-color", "rgb(243, 246, 250)");
  await page.getByRole("radio", { name: "Dark" }).check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");
  await expect(page.getByRole("main")).toHaveCSS("background-color", "rgb(23, 32, 46)");
  await page.getByRole("radio", { name: "Light" }).check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toHaveText("Settings could not be saved. Try again.");
  await expect(page.getByRole("alert")).toContainText("Settings storage is unavailable.");
});

test("shared setup controls show repair actions, clear submitted secrets, and keep Keychain failure visible", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let microphoneRequested = false;
    window.voice = {
      onChanged: () => () => {},
      command: async (command) => {
        if (command.type === "permission.request" && command.permission === "microphone")
          microphoneRequested = true;
        if (command.type === "credential.set") return { ok: false, error: "keychain-unavailable" };
        return {
          ok: true,
          settings: { appearance: "light" },
          status: {
            storage: "ready",
            helper: "ready",
            capture: "unavailable",
            shortcuts: "unavailable",
          },
          setup: {
            native: {
              permissions: {
                microphone: microphoneRequested ? "granted" : "revoked",
                accessibility: "not-requested",
                inputMonitoring: "denied",
              },
              devices: [],
              defaultDevice: null,
              shortcuts: { hold: "unavailable", toggle: "unavailable", cancel: "unavailable" },
            },
            credential: { presence: "missing", verification: "unverified" },
            connectivity: "offline",
            provider: "rate-limited",
            localCapture: "unavailable",
            blockers: [
              "permission-microphone",
              "permission-accessibility",
              "permission-inputMonitoring",
              "input-device",
              "key-missing",
            ],
          },
        };
      },
    };
  });
  await page.goto("/");
  await expect(page.getByText("Microphone · revoked", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review Microphone", exact: true }).click();
  await expect(page.getByText("Microphone · granted", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review Microphone", exact: true })).toBeDisabled();
  await expect(page.getByText("No input device found.", { exact: false })).toBeVisible();
  await expect(page.getByText("You are offline.", { exact: false })).toBeVisible();
  await expect(
    page.getByText("Deepgram is temporarily rate limiting", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Deepgram API key", { exact: true }).fill("synthetic-value");
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  await expect(page.getByLabel("Deepgram API key", { exact: true })).toHaveValue("");
  await expect(page.getByRole("alert")).toContainText("Keychain could not complete the change.");
  await expect(page.getByRole("button", { name: "Add key", exact: true })).toBeDisabled();
});

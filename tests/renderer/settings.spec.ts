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
          status: { storage: "ready", helper: "ready", capture: "unavailable" },
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

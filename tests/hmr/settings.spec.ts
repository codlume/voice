import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

test("component and shared-token HMR preserve an unsaved React preference and the document", async ({
  page,
}) => {
  const componentPath = "apps/desktop/src/renderer/settings.tsx";
  const tokenPath = "packages/ui/src/tokens.stylex.ts";
  const component = await readFile(componentPath, "utf8");
  const token = await readFile(tokenPath, "utf8");
  try {
    await page.addInitScript(() => {
      window.voice = {
        onChanged: () => () => {},
        command: async () => ({
          ok: true,
          settings: { appearance: "light" },
          status: { storage: "ready", helper: "ready", capture: "unavailable" },
        }),
      };
    });
    await page.goto("/");
    await page.getByRole("radio", { name: "Dark" }).check();
    await page.evaluate(() => {
      document.documentElement.dataset.hmrMarker = "same-document";
    });
    await writeFile(
      componentPath,
      component.replace(
        "Choose how Voice looks on your desktop.",
        "Choose your desktop appearance.",
      ),
    );
    await expect(page.getByText("Choose your desktop appearance.")).toBeVisible();
    await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
    await writeFile(tokenPath, token.replace("#f3f6fa", "#e7effa"));
    await expect(page.getByRole("main")).toHaveCSS("background-color", "rgb(231, 239, 250)");
    await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.dataset.hmrMarker)).toBe(
      "same-document",
    );
  } finally {
    await page.close();
    await writeFile(componentPath, component);
    await writeFile(tokenPath, token);
  }
});

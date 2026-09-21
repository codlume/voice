import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4174" },
  webServer: {
    command:
      "pnpm exec vp dev --config apps/desktop/vite.config.ts --host 127.0.0.1 --port 4174 --strictPort",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: false,
    cwd: "../..",
  },
});

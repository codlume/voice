import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig, type PluginOption } from "vite-plus";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    // The plugin is typed against its own vite copy; comparing that Plugin with vite-plus's
    // structurally exceeds TypeScript's depth limit (TS2321), so it enters as an opaque option.
    cloudflareTest({
      main: "./src/index.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          BETTER_AUTH_SECRET: "fake-test-secret-Zq8vN3rT1pWx6YbK4mHs9dLc",
          GOOGLE_CLIENT_ID: "fake-test-client-id",
          GOOGLE_CLIENT_SECRET: "fake-test-client-secret",
        },
      },
    }) as unknown as PluginOption,
  ],
  test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
});

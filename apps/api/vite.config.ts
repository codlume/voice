import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          BETTER_AUTH_SECRET: "fake-test-secret",
          GOOGLE_CLIENT_ID: "fake-test-client-id",
          GOOGLE_CLIENT_SECRET: "fake-test-client-secret",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
});

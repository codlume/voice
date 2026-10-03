declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
  // wrangler.jsonc has no top-level entry point, so the generated types cannot name it.
  // The test pool gets the same module through `main` in vite.config.ts.
  interface GlobalProps {
    mainModule: typeof import("../src/index");
  }
}

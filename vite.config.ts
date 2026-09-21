import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: { "*": "vp fmt --no-error-on-unmatched-pattern" },
  fmt: {
    ignorePatterns: [
      "**/dist/**",
      "out/**",
      "**/.build/**",
      "node_modules/**",
      "pnpm-lock.yaml",
      "test-results/**",
      "playwright-report/**",
    ],
  },
  lint: {
    ignorePatterns: [
      "**/dist/**",
      "out/**",
      "**/.build/**",
      "node_modules/**",
      "test-results/**",
      "playwright-report/**",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: [{ name: "stylex", specifier: "@stylexjs/eslint-plugin" }],
    overrides: [
      {
        files: ["apps/desktop/src/main/storage.ts"],
        rules: { "unicorn/require-post-message-target-origin": "off" },
      },
    ],
    categories: { correctness: "error", suspicious: "warn", perf: "warn" },
    rules: {
      "react/react-in-jsx-scope": "off",
      "eslint/no-await-in-loop": "off",
      "stylex/valid-styles": "error",
      "stylex/valid-shorthands": "error",
      "stylex/no-unused": "error",
    },
  },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});

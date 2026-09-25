import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

const ignorePatterns = [
  ".audit/**",
  "**/.build/**",
  "dist",
  "dist-electron",
  "release",
  "node_modules",
  "pnpm-lock.yaml",
  "*.tsbuildinfo",
];

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**", "**/dist-electron/**", "**/.build/**"],
  },
  staged: {
    "*": "vp fmt --no-error-on-unmatched-pattern",
  },
  fmt: {
    ignorePatterns,
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns,
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "react-in-jsx-scope": "off",
      "eslint/no-await-in-loop": "off",
    },
    options: {
      reportUnusedDisableDirectives: "error",
    },
  },
});

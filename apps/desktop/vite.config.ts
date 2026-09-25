import * as NodeURL from "node:url";

import stylex from "@stylexjs/unplugin";
import react from "@vitejs/plugin-react";
import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

const appDir = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const rendererDir = `${appDir}src/renderer`;

// node-llama-cpp loads a native addon from disk, so it stays external. It also has top-level
// await, so the CJS bundle can only reach it through `await import("node-llama-cpp")`;
// a static import compiles to require() and fails with ERR_REQUIRE_ASYNC_MODULE.
const isExternal = (id: string) =>
  id === "electron" || id.startsWith("electron/") || id === "node-llama-cpp";

const electronEntry = (name: "main" | "preload", entry: string) => ({
  entry: { [name]: entry },
  format: "cjs" as const,
  platform: "node" as const,
  outDir: "dist-electron",
  outExtensions: () => ({ js: ".cjs" }),
  dts: false,
  sourcemap: true,
  clean: false,
  outputOptions: { codeSplitting: false },
  deps: {
    alwaysBundle: (id: string) => !id.startsWith("node:") && !isExternal(id),
    neverBundle: isExternal,
    onlyBundle: false as const,
  },
});

export default defineConfig({
  root: rendererDir,
  base: "./",
  plugins: [stylex.vite({ useCSSLayers: true }), react()],
  server: { port: 5783, strictPort: true },
  build: {
    outDir: `${appDir}dist/renderer`,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        pill: `${rendererDir}/pill.html`,
        hub: `${rendererDir}/hub.html`,
      },
    },
  },
  pack: [electronEntry("main", "src/main/index.ts"), electronEntry("preload", "src/preload.ts")],
  test: {
    root: appDir,
  },
});

import * as NodeURL from "node:url";

import stylex from "@stylexjs/unplugin";
import react from "@vitejs/plugin-react";
import "vite-plus/test/config";
import { defineConfig, type Plugin } from "vite-plus";

const appDir = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const rendererDir = `${appDir}src/renderer`;

// node-llama-cpp loads a native addon from disk, so it stays external. It also has top-level
// await, so the CJS bundle can only reach it through `await import("node-llama-cpp")`;
// a static import compiles to require() and fails with ERR_REQUIRE_ASYNC_MODULE.
const isExternal = (id: string) =>
  id === "electron" ||
  id.startsWith("electron/") ||
  id === "node-llama-cpp" ||
  id === "electron-updater";

const electronEntry = (name: "main" | "preload" | "sentry", entry: string) => ({
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

// Packaged windows load over file://, which carries no response headers, so the policy rides in a
// meta tag. The dev server injects inline scripts (React Refresh), admitted by a nonce, and the
// StyleX dev runtime writes un-nonced <style> elements, so dev styles allow inline.
const DEV_NONCE = "voice-dev";

function contentSecurityPolicy(): Plugin {
  let dev = false;
  return {
    name: "voice:content-security-policy",
    config(_config, { command }) {
      dev = command === "serve";
      return dev ? { html: { cspNonce: DEV_NONCE } } : undefined;
    },
    transformIndexHtml: {
      order: "post",
      handler: () => [
        {
          tag: "meta",
          attrs: {
            "http-equiv": "Content-Security-Policy",
            content: [
              "default-src 'self'",
              dev ? `script-src 'self' 'nonce-${DEV_NONCE}'` : "script-src 'self'",
              dev ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
              // Vite inlines small imported images, such as the app icon, as data: URLs.
              "img-src 'self' data: https://*.googleusercontent.com",
              "object-src 'none'",
              "base-uri 'none'",
              "form-action 'none'",
            ].join("; "),
          },
          injectTo: "head-prepend",
        },
      ],
    },
  };
}

export default defineConfig({
  root: rendererDir,
  base: "./",
  plugins: [stylex.vite({ useCSSLayers: true }), react(), contentSecurityPolicy()],
  server: { port: 5783, strictPort: true },
  // StyleX's dev transform calls this.load() on each import, so a *.stylex.ts file requested
  // during the first crawl waits on a pre-bundled dependency, which by default waits for the
  // crawl to end. That cycle leaves every window blank on a cold start.
  optimizeDeps: { holdUntilCrawlEnd: false },
  build: {
    outDir: `${appDir}dist/renderer`,
    emptyOutDir: true,
    // Maps are uploaded to Sentry at release time; hidden keeps them unreferenced by the bundle.
    sourcemap: "hidden",
    rollupOptions: {
      input: {
        pill: `${rendererDir}/pill.html`,
        hub: `${rendererDir}/hub.html`,
      },
    },
  },
  pack: [
    {
      ...electronEntry("main", "src/main/index.ts"),
      // Baked in at build time so a packaged app never reads it from its environment. Empty
      // (the default) builds an app that cannot send diagnostics at all.
      env: { VOICE_SENTRY_DSN: process.env.VOICE_SENTRY_DSN ?? "" },
    },
    electronEntry("preload", "src/preload.ts"),
    electronEntry("sentry", "src/main/sentry.ts"),
  ],
  test: {
    root: appDir,
    // Processed by Vitest so a test's `vi.mock("electron")` reaches the plugin's Conf storage.
    server: { deps: { inline: ["@better-auth/electron"] } },
  },
});

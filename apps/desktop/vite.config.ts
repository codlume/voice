import { defineConfig } from "vite-plus";
import stylex from "@stylexjs/unplugin";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
  base: "./",
  plugins: [stylex.vite({ useCSSLayers: true }), react()],
  build: { outDir: "../../dist/renderer", emptyOutDir: true },
});

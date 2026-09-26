import cloudflare from "@astrojs/cloudflare";
import stylex from "@stylexjs/unplugin";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "server",
  // The adapter otherwise binds Cloudflare Images and a sessions KV namespace, which the page never uses.
  adapter: cloudflare({ imageService: "passthrough" }),
  session: false,
  vite: { plugins: [stylex.vite({ useCSSLayers: true })] },
});

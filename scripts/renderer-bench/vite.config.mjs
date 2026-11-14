import { mergeConfig } from "vite-plus";

import app from "../../apps/desktop/vite.config.ts";

// The app's renderer build, unchanged except that react-dom is its profiling build, which
// measures how long each commit took to render.
export default mergeConfig(app, {
  resolve: { alias: { "react-dom/client": "react-dom/profiling" } },
});

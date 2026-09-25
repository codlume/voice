import { expect, test } from "vite-plus/test";

import { cleanup } from "./index.ts";

test("placeholder cleanup returns the raw transcript unchanged", async () => {
  await expect(cleanup("Call Ada at 3 pm, um, tomorrow.")).resolves.toBe(
    "Call Ada at 3 pm, um, tomorrow.",
  );
});

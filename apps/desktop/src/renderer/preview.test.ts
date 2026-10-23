import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { HubApi, PillApi } from "../shared/api.ts";
import { BUILT_IN_TRANSFORMS, POLISH_ID } from "../shared/transforms.ts";

vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: () => {} }) }));

// The harness picks its scene from the URL and installs its fake API on window at import.
async function openPreview(search: string): Promise<HubApi & PillApi> {
  const window: { voice?: HubApi & PillApi } = {};
  vi.stubGlobal("window", window);
  vi.stubGlobal("location", { search });
  vi.stubGlobal("document", { getElementById: () => ({}), body: { style: {} } });
  vi.resetModules();
  await import("./preview.tsx");
  if (!window.voice) throw new Error("the preview installed no API");
  return window.voice;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// The first import transforms the whole renderer, which outlasts 5 s on a loaded CI runner.
describe("preview harness", { timeout: 30_000 }, () => {
  test("applies a transforms patch", async () => {
    const voice = await openPreview("?hub=transforms");
    await voice.updateSettings({ transforms: { enabled: true, autoApply: POLISH_ID } });
    const items = BUILT_IN_TRANSFORMS.slice(0, 1);
    await voice.updateSettings({ transforms: { items } });
    expect((await voice.getSnapshot()).settings.transforms).toEqual({
      enabled: true,
      items,
      autoApply: POLISH_ID,
    });
  });

  test.each(["transforming", "transformLoading", "transformTooLong", "transformNotInserted"])(
    "has the %s pill scene",
    async (scene) => {
      const voice = await openPreview(`?pill=${scene}`);
      const { session } = await voice.getPillSnapshot();
      expect(session.kind).toMatch(/^transform/);
    },
  );
});

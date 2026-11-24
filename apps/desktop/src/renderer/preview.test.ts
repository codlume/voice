import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { HubApi, PillApi } from "../shared/api.ts";
import { BUILT_IN_TRANSFORMS, POLISH_ID } from "../shared/transforms.ts";

vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: () => {} }) }));

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

  test.each([
    ["loading", "getSnapshot"],
    ["meetings-loading", "getMeetings"],
  ] as const)("the %s scene never answers %s", async (scene, method) => {
    const voice = await openPreview(`?hub=${scene}`);
    const answer = await Promise.race([
      voice[method]().then(() => "answered"),
      new Promise((resolve) => setTimeout(resolve, 50, "pending")),
    ]);
    expect(answer).toBe("pending");
  });

  test("the restart-notice scene carries a dismissable notice", async () => {
    const voice = await openPreview("?hub=restart-notice");
    expect((await voice.getSnapshot()).restartNotice).toMatchObject({ dismissable: true });
  });

  test("records, pauses and stops a meeting, so live states can be shown", async () => {
    const voice = await openPreview("?hub=meetings");
    const started = await voice.startMeeting();
    if (started.kind !== "ok") throw new Error("the preview refused to start");
    const status = async () =>
      (await voice.getMeetings()).meetings.find(({ id }) => id === started.id)?.status.kind;
    expect(await status()).toBe("recording");
    expect((await voice.startMeeting()).kind).toBe("refused");
    await voice.pauseMeeting(started.id);
    expect(await status()).toBe("paused");
    await voice.stopMeeting(started.id);
    expect(await status()).toBe("ready");
  });
});

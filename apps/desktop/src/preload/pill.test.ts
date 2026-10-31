import { describe, expect, test, vi } from "vite-plus/test";

import { Channel, type PillApi } from "../shared/api.ts";

const listened: string[] = [];
const invoked: unknown[][] = [];
const exposures: { name: string; api: PillApi }[] = [];

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: PillApi) => {
      exposures.push({ name, api });
    },
  },
  ipcRenderer: {
    on: (channel: string) => listened.push(channel),
    off: () => {},
    invoke: (...args: unknown[]) => {
      invoked.push(args);
      return Promise.resolve();
    },
  },
}));
vi.mock("@sentry/electron/preload", () => ({}));

async function load() {
  await import("./pill.ts");
  const [exposed] = exposures;
  if (!exposed) throw new Error("pill preload exposed nothing");
  return exposed;
}

describe("pill preload", () => {
  test("exposes exactly the Flow Bar's members under voice", async () => {
    const { api } = await load();
    expect(exposures.map(({ name }) => name)).toEqual(["voice"]);
    expect(Object.keys(api).toSorted()).toEqual([
      "diagnosticsStartedAtLaunch",
      "getPillSnapshot",
      "onLevel",
      "onPillSnapshot",
      "openNotepad",
      "setPillClickable",
    ]);
  });

  test("listens on nothing at import and only on its own channels once subscribed", async () => {
    const { api } = await load();
    expect(listened).toEqual([]);
    api.onPillSnapshot(() => {});
    api.onLevel(() => {});
    expect(new Set(listened)).toEqual(new Set([Channel.pillSnapshot, Channel.level]));
  });

  test("getPillSnapshot invokes its channel with no payload", async () => {
    const { api } = await load();
    invoked.length = 0;
    await api.getPillSnapshot();
    expect(invoked).toEqual([[Channel.getPillSnapshot]]);
  });
});

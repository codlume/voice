import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { hubApi, pillApi } from "./voice.ts";

const hub = { getSnapshot: () => Promise.resolve() };
const pill = { getPillSnapshot: () => Promise.resolve() };

describe("window bridges", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("the Voice window's page gets its bridge and is refused the Flow Bar's", () => {
    vi.stubGlobal("window", { voice: hub });
    expect(hubApi()).toBe(hub);
    expect(() => pillApi()).toThrow("This page is not the Flow Bar.");
  });

  test("the Flow Bar's page gets its bridge and is refused the Voice window's", () => {
    vi.stubGlobal("window", { voice: pill });
    expect(pillApi()).toBe(pill);
    expect(() => hubApi()).toThrow("This page is not the Voice window.");
  });
});

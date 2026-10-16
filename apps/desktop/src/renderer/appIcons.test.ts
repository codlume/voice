import { describe, expect, test } from "vite-plus/test";

import type { AppIcons } from "../shared/api.ts";
import type { BundleId } from "../shared/app-categories.ts";
import { createIconLoader } from "./appIcons.ts";

const MAIL = "com.apple.mail" as BundleId;
const SLACK = "com.tinyspeck.slackmacgap" as BundleId;
const XCODE = "com.apple.dt.xcode" as BundleId;

function setup(answer: (bundleIds: BundleId[]) => AppIcons | Error = (ids) => icons(ids)) {
  const fetches: BundleId[][] = [];
  const loader = createIconLoader(async (bundleIds) => {
    fetches.push(bundleIds);
    const result = answer(bundleIds);
    if (result instanceof Error) throw result;
    return result;
  });
  return { loader, fetches };
}

const icons = (ids: readonly BundleId[]): AppIcons =>
  Object.fromEntries(ids.map((id) => [id, `data:image/png;base64,${id}`]));

describe("icon loader", () => {
  test("sends the requests of one tick as one fetch and serves each its icon", async () => {
    const { loader, fetches } = setup();
    const [mail, slack] = await Promise.all([loader.load(MAIL), loader.load(SLACK)]);
    expect(fetches).toEqual([[MAIL, SLACK]]);
    expect(mail).toBe(`data:image/png;base64,${MAIL}`);
    expect(slack).toBe(`data:image/png;base64,${SLACK}`);
    expect(loader.get(MAIL)).toBe(mail);
  });

  test("a request from a later tick travels in its own fetch", async () => {
    const { loader, fetches } = setup();
    await loader.load(MAIL);
    await loader.load(SLACK);
    expect(fetches).toEqual([[MAIL], [SLACK]]);
  });

  test("serves a loaded icon from memory and asks once for an id requested twice in flight", async () => {
    const { loader, fetches } = setup();
    await Promise.all([loader.load(MAIL), loader.load(MAIL)]);
    expect(await loader.load(MAIL)).toBe(`data:image/png;base64,${MAIL}`);
    expect(fetches).toEqual([[MAIL]]);
  });

  test("has no icon for an app the fetch left out, and asks for it again next time", async () => {
    const { loader, fetches } = setup((ids) => icons(ids.filter((id) => id !== XCODE)));
    expect(await Promise.all([loader.load(XCODE), loader.load(MAIL)])).toEqual([
      null,
      `data:image/png;base64,${MAIL}`,
    ]);
    expect(loader.get(XCODE)).toBeNull();
    expect(await loader.load(XCODE)).toBeNull();
    expect(fetches).toEqual([[XCODE, MAIL], [XCODE]]);
  });

  test("a failed fetch leaves no icon and the next load asks again", async () => {
    let fail = true;
    const { loader, fetches } = setup((ids) => (fail ? new Error("helper down") : icons(ids)));
    expect(await loader.load(MAIL)).toBeNull();
    fail = false;
    expect(await loader.load(MAIL)).toBe(`data:image/png;base64,${MAIL}`);
    expect(fetches).toEqual([[MAIL], [MAIL]]);
  });
});

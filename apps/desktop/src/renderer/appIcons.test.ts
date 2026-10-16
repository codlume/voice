import { describe, expect, test } from "vite-plus/test";

import { createInstalledApps } from "../main/installed-apps.ts";
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

  test("invalidating keeps the icon on show, tells subscribers once, and makes the next load ask again", async () => {
    const { loader, fetches } = setup();
    let notified = 0;
    loader.subscribe(() => (notified += 1));
    await loader.load(MAIL);
    loader.invalidate();
    expect(loader.get(MAIL)).toBe(`data:image/png;base64,${MAIL}`);
    await Promise.all([loader.load(MAIL), loader.load(MAIL)]);
    await loader.load(MAIL);
    expect(fetches).toEqual([[MAIL], [MAIL]]);
    expect(notified).toBe(2);
  });

  test("forgets a stale icon when the fetch after invalidating leaves the app out", async () => {
    let gone = false;
    const { loader } = setup((ids) => icons(gone ? ids.filter((id) => id !== MAIL) : ids));
    await loader.load(MAIL);
    gone = true;
    loader.invalidate();
    expect(await loader.load(MAIL)).toBeNull();
    expect(loader.get(MAIL)).toBeNull();
  });
});

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("icon loader invalidated while a fetch is in flight", () => {
  function held() {
    const fetches: { ids: BundleId[]; settle: (result: AppIcons | Error) => void }[] = [];
    const loader = createIconLoader(
      (ids) =>
        new Promise<AppIcons>((resolve, reject) =>
          fetches.push({
            ids,
            settle: (result) => (result instanceof Error ? reject(result) : resolve(result)),
          }),
        ),
    );
    const mounted = () => void loader.load(MAIL);
    loader.subscribe(mounted);
    mounted();
    return { loader, fetches };
  }

  test.each([
    ["an obsolete icon", { [MAIL]: "v1" }],
    ["no icon", {}],
    ["a failure", new Error("helper down")],
  ] as const)(
    "asks again for the current list when the obsolete fetch returns %s",
    async (_, obsolete) => {
      const { loader, fetches } = held();
      await settled();
      loader.invalidate();
      fetches[0]?.settle(obsolete);
      await settled();
      expect(fetches.map(({ ids }) => ids)).toEqual([[MAIL], [MAIL]]);
      fetches[1]?.settle({ [MAIL]: "v2" });
      await settled();
      expect(loader.get(MAIL)).toBe("v2");
      expect(fetches).toHaveLength(2);
    },
  );

  test("shows an obsolete answer and replaces it with the answer for the current list", async () => {
    const { loader, fetches } = held();
    await settled();
    fetches[0]?.settle({ [MAIL]: "v1" });
    await settled();
    loader.invalidate();
    await settled();
    expect(fetches).toHaveLength(2);
    loader.invalidate();
    fetches[1]?.settle({ [MAIL]: "v2" });
    await settled();
    expect(loader.get(MAIL)).toBe("v2");
    fetches[2]?.settle({ [MAIL]: "v3" });
    await settled();
    expect(loader.get(MAIL)).toBe("v3");
    expect(fetches).toHaveLength(3);
  });
});

describe("icon loader over the installed apps service", () => {
  const MAIL_APP = {
    bundleId: "com.apple.mail",
    name: "Mail",
    path: "/System/Applications/Mail.app",
    modifiedMs: 1,
    browser: false,
  };

  function helper() {
    let app = MAIL_APP;
    const renders: string[][] = [];
    const installed = createInstalledApps({
      send: (command) =>
        queueMicrotask(() => {
          if (command.type === "apps.list") {
            installed.onHelperEvent({ type: "apps.listed", apps: [app] });
          } else if (command.type === "icons.render") {
            renders.push(command.paths);
            installed.onHelperEvent({
              type: "icons.rendered",
              id: command.id,
              icons: [{ path: app.path, png: `icon-v${app.modifiedMs}` }],
            });
          }
        }),
    });
    return { installed, renders, update: () => (app = { ...app, modifiedMs: app.modifiedMs + 1 }) };
  }

  test("an app updated in place keeps its old icon on show until the new one arrives", async () => {
    const { installed, renders, update } = helper();
    const loader = createIconLoader((ids) => installed.icons(ids));
    const shown: (string | null)[] = [];
    loader.subscribe(() => shown.push(loader.get(MAIL)));
    await installed.list();
    expect(await loader.load(MAIL)).toBe("data:image/png;base64,icon-v1");
    update();
    await installed.list();
    loader.invalidate();
    expect(loader.get(MAIL)).toBe("data:image/png;base64,icon-v1");
    expect(await loader.load(MAIL)).toBe("data:image/png;base64,icon-v2");
    expect(shown).toEqual([
      "data:image/png;base64,icon-v1",
      "data:image/png;base64,icon-v1",
      "data:image/png;base64,icon-v2",
    ]);
    expect(renders).toEqual([[MAIL_APP.path], [MAIL_APP.path]]);
  });

  test("a remount after a list that changed nothing asks main, which answers from memory", async () => {
    const { installed, renders } = helper();
    const loader = createIconLoader((ids) => installed.icons(ids));
    await installed.list();
    await loader.load(MAIL);
    await installed.list();
    loader.invalidate();
    expect(await loader.load(MAIL)).toBe("data:image/png;base64,icon-v1");
    expect(renders).toEqual([[MAIL_APP.path]]);
  });
});

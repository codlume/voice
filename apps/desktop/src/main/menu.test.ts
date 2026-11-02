import { describe, expect, test } from "vite-plus/test";

import { applicationMenuTemplate } from "./menu.ts";

const roles = (development: boolean) =>
  applicationMenuTemplate(() => {}, { development })
    .flatMap((item) => (Array.isArray(item.submenu) ? [item].concat(item.submenu) : [item]))
    .map((item) => item.role);

describe("applicationMenuTemplate", () => {
  test("a packaged build has no reload or developer tools", () => {
    expect(roles(false)).not.toContain("reload");
    expect(roles(false)).not.toContain("forceReload");
    expect(roles(false)).not.toContain("toggleDevTools");
  });

  test("a development build keeps reload and developer tools", () => {
    expect(roles(true)).toEqual(
      expect.arrayContaining(["reload", "forceReload", "toggleDevTools"]),
    );
  });

  test("both builds keep zoom and full screen", () => {
    for (const development of [true, false]) {
      const view = applicationMenuTemplate(() => {}, { development }).find(
        (item) => item.label === "View",
      );
      const submenu = Array.isArray(view?.submenu) ? view.submenu : [];
      expect(submenu.map((item) => item.id ?? item.role).filter(Boolean)).toEqual(
        expect.arrayContaining(["zoom-reset", "zoom-in", "zoom-out", "togglefullscreen"]),
      );
      expect(submenu[0]?.type).not.toBe("separator");
    }
  });
});

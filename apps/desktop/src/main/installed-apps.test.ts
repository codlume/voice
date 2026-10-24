import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { BundleId } from "../shared/app-categories.ts";
import { createInstalledApps, ICONS_PER_HELPER_LINE } from "./installed-apps.ts";
import type { HelperCommand } from "./protocol.ts";

type Listed = {
  bundleId: string;
  name: string;
  path: string;
  modifiedMs: number;
  browser: boolean;
};

const MAIL = {
  bundleId: "com.apple.mail",
  name: "Mail",
  path: "/System/Applications/Mail.app",
  modifiedMs: 1,
  browser: false,
};
const SLACK = {
  bundleId: "com.tinyspeck.slackmacgap",
  name: "Slack",
  path: "/Applications/Slack.app",
  modifiedMs: 1,
  browser: false,
};
const XCODE = {
  bundleId: "com.apple.dt.Xcode",
  name: "Xcode",
  path: "/Applications/Xcode.app",
  modifiedMs: 1,
  browser: false,
};
const CHROME = {
  bundleId: "com.google.Chrome",
  name: "Google Chrome",
  path: "/Applications/Google Chrome.app",
  modifiedMs: 1,
  browser: true,
};

const id = (app: Listed) => app.bundleId.toLowerCase() as BundleId;
const png = ({ path, modifiedMs }: Listed) => `png-of-${path}@${modifiedMs}`;
const dataUrl = (app: Listed) => `data:image/png;base64,${png(app)}`;

function setup(options: {
  apps: Listed[];
  /** A silent helper takes the command and never replies; a down helper is not running to take it. */
  helper?: "answers" | "silent" | "down";
  renders?: boolean;
}) {
  const sent: HelperCommand[] = [];
  const state = {
    apps: options.apps,
    helper: options.helper ?? "answers",
    renders: options.renders ?? true,
  };
  const installed = createInstalledApps({
    send: (command) => {
      sent.push(command);
      if (state.helper !== "answers") return state.helper === "silent";
      queueMicrotask(() => {
        if (command.type === "apps.list") {
          installed.onHelperEvent({ type: "apps.listed", apps: state.apps });
        } else if (command.type === "icons.render" && state.renders) {
          const icons = state.apps
            .filter(({ path }) => command.paths.includes(path))
            .map((app) => ({ path: app.path, png: png(app) }));
          installed.onHelperEvent({ type: "icons.rendered", id: command.id, icons });
        }
      });
      return true;
    },
  });
  const renders = () =>
    sent.flatMap((command) => (command.type === "icons.render" ? [command.paths] : []));
  return { installed, sent, state, renders };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("installed apps", () => {
  test("lists apps with their browser flag without rendering any icon", async () => {
    const { installed, renders } = setup({ apps: [MAIL, CHROME, XCODE] });
    expect(await installed.list()).toEqual([
      { bundleId: "com.apple.mail", name: "Mail", browser: false },
      { bundleId: "com.google.chrome", name: "Google Chrome", browser: true },
      { bundleId: "com.apple.dt.xcode", name: "Xcode", browser: false },
    ]);
    expect(renders()).toEqual([]);
  });

  test("renders the requested icons of listed apps once, then serves them from memory", async () => {
    const { installed, renders } = setup({ apps: [MAIL, XCODE] });
    await installed.list();
    const ids = [id(XCODE), id(MAIL), "com.example.unlisted" as BundleId];
    const expected = { [id(XCODE)]: dataUrl(XCODE), [id(MAIL)]: dataUrl(MAIL) };
    expect(await installed.icons(ids)).toEqual(expected);
    expect(await installed.icons(ids)).toEqual(expected);
    await installed.list();
    expect(await installed.icons([id(MAIL)])).toEqual({ [id(MAIL)]: dataUrl(MAIL) });
    expect(renders()).toEqual([[XCODE.path, MAIL.path]]);
  });

  test("renders only a moved or newly installed app again on the next list", async () => {
    const { installed, state, renders } = setup({ apps: [MAIL, SLACK] });
    await installed.list();
    await installed.icons([id(MAIL), id(SLACK)]);
    const movedSlack = { ...SLACK, path: "/Users/test/Applications/Slack.app" };
    const whatsapp = {
      bundleId: "net.whatsapp.WhatsApp",
      name: "WhatsApp",
      path: "/Applications/WhatsApp.app",
      modifiedMs: 1,
      browser: false,
    };
    state.apps = [MAIL, movedSlack, whatsapp];
    await installed.list();
    expect(await installed.icons([id(MAIL), id(SLACK), id(whatsapp)])).toEqual({
      [id(MAIL)]: dataUrl(MAIL),
      [id(SLACK)]: dataUrl(movedSlack),
      [id(whatsapp)]: dataUrl(whatsapp),
    });
    expect(renders()).toEqual([
      [MAIL.path, SLACK.path],
      [movedSlack.path, whatsapp.path],
    ]);
  });

  test("renders an app again when its bundle changed in place", async () => {
    const { installed, state, renders } = setup({ apps: [MAIL, SLACK] });
    await installed.list();
    await installed.icons([id(MAIL), id(SLACK)]);
    const updatedSlack = { ...SLACK, modifiedMs: 2 };
    state.apps = [MAIL, updatedSlack];
    await installed.list();
    expect(await installed.icons([id(MAIL), id(SLACK)])).toEqual({
      [id(MAIL)]: dataUrl(MAIL),
      [id(SLACK)]: dataUrl(updatedSlack),
    });
    expect(renders()).toEqual([[MAIL.path, SLACK.path], [SLACK.path]]);
  });

  test("forgets a removed app's icon and renders it again after a reinstall", async () => {
    const { installed, state, renders } = setup({ apps: [MAIL, SLACK] });
    await installed.list();
    await installed.icons([id(MAIL), id(SLACK)]);
    state.apps = [MAIL];
    await installed.list();
    expect(await installed.icons([id(MAIL), id(SLACK)])).toEqual({ [id(MAIL)]: dataUrl(MAIL) });
    state.apps = [MAIL, SLACK];
    await installed.list();
    expect(await installed.icons([id(MAIL), id(SLACK)])).toEqual({
      [id(MAIL)]: dataUrl(MAIL),
      [id(SLACK)]: dataUrl(SLACK),
    });
    expect(renders()).toEqual([[MAIL.path, SLACK.path], [SLACK.path]]);
  });

  test("splits a large render into batches", async () => {
    const apps = Array.from({ length: ICONS_PER_HELPER_LINE + 3 }, (_, i) => ({
      bundleId: `com.example.app${i}`,
      name: `App ${i}`,
      path: `/Applications/App ${i}.app`,
      modifiedMs: 1,
      browser: false,
    }));
    const { installed, renders } = setup({ apps });
    await installed.list();
    const icons = await installed.icons(apps.map(id));
    expect(Object.keys(icons)).toHaveLength(apps.length);
    expect(renders().map((paths) => paths.length)).toEqual([ICONS_PER_HELPER_LINE, 3]);
  });

  test("lowercases ids, keeps the first of a duplicate, and drops an invalid id", async () => {
    const { installed } = setup({
      apps: [
        {
          bundleId: "com.apple.MobileSMS",
          name: "Messages",
          path: "/System/Applications/Messages.app",
          modifiedMs: 1,
          browser: false,
        },
        {
          bundleId: "COM.APPLE.MOBILESMS",
          name: "Old Messages",
          path: "/Applications/Messages.app",
          modifiedMs: 1,
          browser: false,
        },
        {
          bundleId: "com.apple/mail",
          name: "Bad",
          path: "/Applications/Bad.app",
          modifiedMs: 1,
          browser: false,
        },
      ],
    });
    expect(await installed.list()).toEqual([
      { bundleId: "com.apple.mobilesms", name: "Messages", browser: false },
    ]);
  });

  test("resolves a list the helper answers after several seconds", async () => {
    vi.useFakeTimers();
    const { installed } = setup({ apps: [MAIL], helper: "silent" });
    const list = installed.list();
    await vi.advanceTimersByTimeAsync(6000);
    installed.onHelperEvent({ type: "apps.listed", apps: [MAIL] });
    expect(await list).toEqual([{ bundleId: "com.apple.mail", name: "Mail", browser: false }]);
  });

  test("asks the helper once while a list is in flight", async () => {
    const { installed, sent } = setup({ apps: [XCODE] });
    const [a, b] = await Promise.all([installed.list(), installed.list()]);
    expect(a).toBe(b);
    expect(sent.filter((command) => command.type === "apps.list")).toHaveLength(1);
  });

  test("rejects a list in flight when the helper exits, and a later list starts fresh", async () => {
    const { installed, state } = setup({ apps: [MAIL], helper: "silent" });
    const first = expect(installed.list()).rejects.toThrow();
    installed.helperExited();
    await first;
    state.helper = "answers";
    expect(await installed.list()).toEqual([
      { bundleId: "com.apple.mail", name: "Mail", browser: false },
    ]);
  });

  test("rejects a list the helper was not running to receive", async () => {
    const { installed, sent } = setup({ apps: [MAIL], helper: "down" });
    await expect(installed.list()).rejects.toThrow();
    expect(sent.map((command) => command.type)).toEqual(["apps.list"]);
  });

  test("an icon asked for while the first list is in flight waits for that list", async () => {
    const { installed, sent } = setup({ apps: [MAIL] });
    const [, icons] = await Promise.all([installed.list(), installed.icons([id(MAIL)])]);
    expect(icons).toEqual({ [id(MAIL)]: dataUrl(MAIL) });
    expect(sent.filter((command) => command.type === "apps.list")).toHaveLength(1);
  });

  test("serves a cached icon while a later list is still unanswered", async () => {
    const { installed, state } = setup({ apps: [MAIL] });
    await installed.list();
    await installed.icons([id(MAIL)]);
    state.helper = "silent";
    void installed.list();
    expect(await installed.icons([id(MAIL)])).toEqual({ [id(MAIL)]: dataUrl(MAIL) });
  });

  test("an icon asked for before any list runs the list first", async () => {
    const { installed, sent } = setup({ apps: [MAIL] });
    expect(await installed.icons([id(MAIL)])).toEqual({ [id(MAIL)]: dataUrl(MAIL) });
    expect(sent.map((command) => command.type)).toEqual(["apps.list", "icons.render"]);
  });

  test("returns no icons when the helper exits before the first list arrives", async () => {
    const { installed } = setup({ apps: [MAIL], helper: "silent" });
    const icons = installed.icons([id(MAIL)]);
    installed.helperExited();
    expect(await icons).toEqual({});
  });

  test("leaves out an icon the helper could not render, and asks for it again next time", async () => {
    const sent: HelperCommand[] = [];
    const installed = createInstalledApps({
      send: (command) => {
        sent.push(command);
        queueMicrotask(() => {
          if (command.type === "apps.list") {
            installed.onHelperEvent({ type: "apps.listed", apps: [XCODE] });
          } else if (command.type === "icons.render") {
            installed.onHelperEvent({ type: "icons.rendered", id: command.id, icons: [] });
          }
        });
        return true;
      },
    });
    await installed.list();
    expect(await installed.icons([id(XCODE)])).toEqual({});
    expect(await installed.icons([id(XCODE)])).toEqual({});
    expect(sent.filter((command) => command.type === "icons.render")).toHaveLength(2);
  });

  test("gives up a render when the helper exits, and a reply to it does not complete the next render", async () => {
    const replies = new Map<string, () => void>();
    const installed = createInstalledApps({
      send: (command) => {
        if (command.type === "apps.list") {
          queueMicrotask(() =>
            installed.onHelperEvent({ type: "apps.listed", apps: [MAIL, XCODE] }),
          );
        } else if (command.type === "icons.render") {
          const icons = [MAIL, XCODE]
            .filter(({ path }) => command.paths.includes(path))
            .map((app) => ({ path: app.path, png: png(app) }));
          replies.set(command.paths.join(), () =>
            installed.onHelperEvent({ type: "icons.rendered", id: command.id, icons }),
          );
        }
        return true;
      },
    });
    await installed.list();
    const mail = installed.icons([id(MAIL)]);
    installed.helperExited();
    expect(await mail).toEqual({});

    let xcodeDone = false;
    const xcode = installed.icons([id(XCODE)]).then((icons) => {
      xcodeDone = true;
      return icons;
    });
    replies.get(MAIL.path)?.();
    await new Promise((resolve) => setTimeout(resolve));
    expect(xcodeDone).toBe(false);
    replies.get(XCODE.path)?.();
    expect(await xcode).toEqual({ [id(XCODE)]: dataUrl(XCODE) });
  });
});

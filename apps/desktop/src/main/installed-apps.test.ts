import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { createInstalledApps } from "./installed-apps.ts";
import type { HelperCommand } from "./protocol.ts";

type Listed = { bundleId: string; name: string; path: string };

const MAIL = { bundleId: "com.apple.mail", name: "Mail", path: "/System/Applications/Mail.app" };
const SLACK = {
  bundleId: "com.tinyspeck.slackmacgap",
  name: "Slack",
  path: "/Applications/Slack.app",
};
const XCODE = { bundleId: "com.apple.dt.Xcode", name: "Xcode", path: "/Applications/Xcode.app" };

const png = (path: string) => `png-of-${path}`;
const dataUrl = (path: string) => `data:image/png;base64,${png(path)}`;

function setup(options: { apps: Listed[]; answer?: boolean }) {
  const sent: HelperCommand[] = [];
  const state = { apps: options.apps, answer: options.answer ?? true };
  const installed = createInstalledApps({
    timeoutMs: 1000,
    send: (command) => {
      sent.push(command);
      if (!state.answer) return;
      queueMicrotask(() => {
        if (command.type === "apps.list") {
          installed.onHelperEvent({ type: "apps.listed", apps: state.apps });
        } else if (command.type === "icons.render") {
          const icons = command.paths.map((path) => ({ path, png: png(path) }));
          installed.onHelperEvent({ type: "icons.rendered", icons });
        }
      });
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
  test("renders icons only for catalog apps", async () => {
    const { installed, renders } = setup({ apps: [MAIL, XCODE, SLACK] });
    expect(await installed.list()).toEqual([
      { bundleId: "com.apple.mail", name: "Mail", icon: dataUrl(MAIL.path) },
      { bundleId: "com.apple.dt.xcode", name: "Xcode", icon: null },
      { bundleId: "com.tinyspeck.slackmacgap", name: "Slack", icon: dataUrl(SLACK.path) },
    ]);
    expect(renders()).toEqual([[MAIL.path, SLACK.path]]);
  });

  test("serves icons it already has from memory", async () => {
    const { installed, renders } = setup({ apps: [MAIL, SLACK] });
    const first = await installed.list();
    expect(await installed.list()).toEqual(first);
    expect(renders()).toHaveLength(1);
  });

  test("renders only a moved or newly installed catalog app on the next list", async () => {
    const { installed, state, renders } = setup({ apps: [MAIL, SLACK] });
    await installed.list();
    const movedSlack = { ...SLACK, path: "/Users/test/Applications/Slack.app" };
    const whatsapp = {
      bundleId: "net.whatsapp.WhatsApp",
      name: "WhatsApp",
      path: "/Applications/WhatsApp.app",
    };
    state.apps = [MAIL, movedSlack, whatsapp];
    expect(await installed.list()).toEqual([
      { bundleId: "com.apple.mail", name: "Mail", icon: dataUrl(MAIL.path) },
      { bundleId: "com.tinyspeck.slackmacgap", name: "Slack", icon: dataUrl(movedSlack.path) },
      { bundleId: "net.whatsapp.whatsapp", name: "WhatsApp", icon: dataUrl(whatsapp.path) },
    ]);
    expect(renders()).toEqual([
      [MAIL.path, SLACK.path],
      [movedSlack.path, whatsapp.path],
    ]);
  });

  test("lowercases ids, keeps the first of a duplicate, and drops an invalid id", async () => {
    const { installed } = setup({
      apps: [
        {
          bundleId: "com.apple.MobileSMS",
          name: "Messages",
          path: "/System/Applications/Messages.app",
        },
        {
          bundleId: "COM.APPLE.MOBILESMS",
          name: "Old Messages",
          path: "/Applications/Messages.app",
        },
        { bundleId: "com.apple/mail", name: "Bad", path: "/Applications/Bad.app" },
      ],
    });
    expect(await installed.list()).toEqual([
      {
        bundleId: "com.apple.mobilesms",
        name: "Messages",
        icon: dataUrl("/System/Applications/Messages.app"),
      },
    ]);
  });

  test("asks the helper once while a list is in flight", async () => {
    const { installed, sent } = setup({ apps: [XCODE] });
    const [a, b] = await Promise.all([installed.list(), installed.list()]);
    expect(a).toBe(b);
    expect(sent.filter((command) => command.type === "apps.list")).toHaveLength(1);
  });

  test("rejects when the helper never lists apps, and a later list starts fresh", async () => {
    vi.useFakeTimers();
    const { installed, state } = setup({ apps: [MAIL], answer: false });
    const first = expect(installed.list()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1000);
    await first;
    state.answer = true;
    expect(await installed.list()).toEqual([
      { bundleId: "com.apple.mail", name: "Mail", icon: dataUrl(MAIL.path) },
    ]);
  });

  test("returns the list without icons when the helper never renders them", async () => {
    vi.useFakeTimers();
    const sent: HelperCommand[] = [];
    const installed = createInstalledApps({
      timeoutMs: 1000,
      send: (command) => {
        sent.push(command);
        if (command.type === "apps.list") {
          queueMicrotask(() => installed.onHelperEvent({ type: "apps.listed", apps: [MAIL] }));
        }
      },
    });
    const listed = installed.list();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await listed).toEqual([{ bundleId: "com.apple.mail", name: "Mail", icon: null }]);
  });
});

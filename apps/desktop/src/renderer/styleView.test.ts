import { describe, expect, test } from "vite-plus/test";

import type { InstalledApp } from "../shared/api.ts";
import { parseBundleId } from "../shared/app-categories.ts";
import { bannerApps } from "./styleView.ts";

function app(id: string, name: string, icon: string | null = `data:image/png;base64,${name}`) {
  const bundleId = parseBundleId(id);
  if (bundleId === null) throw new Error(`bad fixture id ${id}`);
  return { bundleId, name, icon } satisfies InstalledApp;
}

const image = (id: string, name: string, catalogName = name) => ({
  bundleId: id.toLowerCase(),
  name: catalogName,
  icon: `data:image/png;base64,${name}`,
  letter: catalogName.slice(0, 1),
});

const installed = [
  app("com.apple.dt.Xcode", "Xcode"),
  app("com.google.Chrome", "Google Chrome"),
  app("com.apple.mail", "Mail"),
  app("com.tinyspeck.slackmacgap", "Slack"),
  app("net.whatsapp.WhatsApp", "WhatsApp"),
  app("com.apple.MobileSMS", "Messages"),
  app("com.microsoft.Outlook", "Microsoft Outlook"),
];

describe("bannerApps", () => {
  test("shows each category's installed apps in catalog order, without browsers or unknown apps", () => {
    expect(bannerApps("personal", installed)).toEqual({
      shown: [image("com.apple.MobileSMS", "Messages"), image("net.whatsapp.WhatsApp", "WhatsApp")],
      overflow: [],
    });
    expect(bannerApps("work", installed)).toEqual({
      shown: [image("com.tinyspeck.slackmacgap", "Slack")],
      overflow: [],
    });
    expect(bannerApps("email", installed)).toEqual({
      shown: [
        image("com.apple.mail", "Mail"),
        image("com.microsoft.Outlook", "Microsoft Outlook", "Outlook"),
      ],
      overflow: [],
    });
  });

  test("shows four icons and names the rest as overflow", () => {
    const personal = [
      app("com.hnc.Discord", "Discord"),
      app("com.tencent.xinWeChat", "WeChat"),
      app("org.whispersystems.signal-desktop", "Signal"),
      app("ru.keepcoder.Telegram", "Telegram"),
      app("net.whatsapp.WhatsApp", "WhatsApp"),
      app("com.apple.MobileSMS", "Messages"),
    ];
    expect(bannerApps("personal", personal)).toEqual({
      shown: [
        image("com.apple.MobileSMS", "Messages"),
        image("net.whatsapp.WhatsApp", "WhatsApp"),
        image("ru.keepcoder.Telegram", "Telegram"),
        image("org.whispersystems.signal-desktop", "Signal"),
      ],
      overflow: ["WeChat", "Discord"],
    });
  });

  test("shows a monogram for an app without an icon", () => {
    expect(bannerApps("work", [app("us.zoom.xos", "zoom.us", null)])).toEqual({
      shown: [{ bundleId: "us.zoom.xos", name: "Zoom", icon: null, letter: "Z" }],
      overflow: [],
    });
  });

  test("shows nothing for Other or when no app of the category is installed", () => {
    expect(bannerApps("other", installed)).toEqual({ shown: [], overflow: [] });
    expect(bannerApps("work", [])).toEqual({ shown: [], overflow: [] });
  });
});

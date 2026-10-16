import { describe, expect, test } from "vite-plus/test";

import type { InstalledApp } from "../shared/api.ts";
import { parseBundleId } from "../shared/app-categories.ts";
import { bannerApps } from "./styleView.ts";

function app(id: string, name: string, browser = false) {
  const bundleId = parseBundleId(id);
  if (bundleId === null) throw new Error(`bad fixture id ${id}`);
  return { bundleId, name, browser } satisfies InstalledApp;
}

const tile = (id: string, name: string) => ({ bundleId: id.toLowerCase(), name });

const installed = [
  app("com.apple.dt.Xcode", "Xcode"),
  app("com.google.Chrome", "Google Chrome", true),
  app("com.apple.mail", "Mail"),
  app("com.tinyspeck.slackmacgap", "Slack"),
  app("net.whatsapp.WhatsApp", "WhatsApp"),
  app("com.apple.MobileSMS", "Messages"),
  app("com.microsoft.Outlook", "Microsoft Outlook"),
];

describe("bannerApps", () => {
  test("shows each category's installed apps in catalog order, without browsers or unknown apps", () => {
    expect(bannerApps("personal", installed)).toEqual({
      shown: [tile("com.apple.MobileSMS", "Messages"), tile("net.whatsapp.WhatsApp", "WhatsApp")],
      overflow: [],
    });
    expect(bannerApps("work", installed)).toEqual({
      shown: [tile("com.tinyspeck.slackmacgap", "Slack")],
      overflow: [],
    });
    expect(bannerApps("email", installed)).toEqual({
      shown: [tile("com.apple.mail", "Mail"), tile("com.microsoft.Outlook", "Outlook")],
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
        tile("com.apple.MobileSMS", "Messages"),
        tile("net.whatsapp.WhatsApp", "WhatsApp"),
        tile("ru.keepcoder.Telegram", "Telegram"),
        tile("org.whispersystems.signal-desktop", "Signal"),
      ],
      overflow: ["WeChat", "Discord"],
    });
  });

  test("shows an app installed under two catalog ids once, by its first catalog id", () => {
    const work = [
      app("com.microsoft.teams2", "Microsoft Teams"),
      app("com.microsoft.teams", "Microsoft Teams classic"),
      app("com.tinyspeck.slackmacgap", "Slack"),
    ];
    expect(bannerApps("work", work)).toEqual({
      shown: [
        tile("com.tinyspeck.slackmacgap", "Slack"),
        tile("com.microsoft.teams", "Microsoft Teams"),
      ],
      overflow: [],
    });
  });

  test("shows nothing for Other or when no app of the category is installed", () => {
    expect(bannerApps("other", installed)).toEqual({ shown: [], overflow: [] });
    expect(bannerApps("work", [])).toEqual({ shown: [], overflow: [] });
  });
});

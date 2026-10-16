import { readFileSync } from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, test } from "vite-plus/test";

import type { InstalledApp } from "../shared/api.ts";
import { parseBundleId, type Category } from "../shared/app-categories.ts";
import { parseAssignments } from "../shared/style.ts";
import {
  bannerApps,
  chips,
  pickerRows,
  rowHint,
  siteInput,
  VOICE_BUNDLE_ID,
  type SiteInput,
} from "./styleView.ts";

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

const assigned = (...items: unknown[]) => parseAssignments(items);
const slackToPersonal = assigned({
  kind: "app",
  bundleId: "com.tinyspeck.slackmacgap",
  name: "Slack",
  category: "personal",
});

describe("bannerApps", () => {
  test("shows each category's installed apps in catalog order, without browsers or unknown apps", () => {
    expect(bannerApps("personal", installed, [])).toEqual({
      shown: [tile("com.apple.MobileSMS", "Messages"), tile("net.whatsapp.WhatsApp", "WhatsApp")],
      overflow: [],
    });
    expect(bannerApps("work", installed, [])).toEqual({
      shown: [tile("com.tinyspeck.slackmacgap", "Slack")],
      overflow: [],
    });
    expect(bannerApps("email", installed, [])).toEqual({
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
    expect(bannerApps("personal", personal, [])).toEqual({
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
    expect(bannerApps("work", work, [])).toEqual({
      shown: [
        tile("com.tinyspeck.slackmacgap", "Slack"),
        tile("com.microsoft.teams", "Microsoft Teams"),
      ],
      overflow: [],
    });
  });

  test("shows nothing for Other or when no app of the category is installed", () => {
    expect(bannerApps("other", installed, [])).toEqual({ shown: [], overflow: [] });
    expect(bannerApps("work", [], [])).toEqual({ shown: [], overflow: [] });
  });

  test("a built-in app the user moved leaves its built-in banner", () => {
    expect(bannerApps("work", installed, slackToPersonal)).toEqual({ shown: [], overflow: [] });
    expect(
      bannerApps("personal", installed, slackToPersonal).shown.map(({ name }) => name),
    ).toEqual(["Messages", "WhatsApp"]);
  });
});

describe("chips", () => {
  test("lists the category's own assignments, apps by bundle id and sites by host", () => {
    const assignments = assigned(
      { kind: "app", bundleId: "com.apple.dt.Xcode", name: "Xcode", category: "work" },
      { kind: "site", host: "linear.app", category: "work" },
      { kind: "app", bundleId: "com.tinyspeck.slackmacgap", name: "Slack", category: "personal" },
    );
    expect(
      chips("work", assignments).map(({ key, bundleId, name }) => ({ key, bundleId, name })),
    ).toEqual([
      { key: "app:com.apple.dt.xcode", bundleId: "com.apple.dt.xcode", name: "Xcode" },
      { key: "site:linear.app", bundleId: null, name: "linear.app" },
    ]);
    expect(chips("email", assignments)).toEqual([]);
  });
});

describe("pickerRows", () => {
  const apps = [
    ...installed,
    app("com.apple.TextEdit", "TextEdit"),
    app("com.apple.Safari", "Safari", true),
    app("com.voice.app", "Voice"),
    app("com.apple.Notes", "Notes"),
    app("us.zoom.xos", "zoom.us"),
  ];
  const names = (category: Category, query: string, assignments = assigned()) =>
    pickerRows(category, apps, assignments, query).map(({ name }) => name);

  test("offers every installed app but browsers and Voice, by name, with catalog names", () => {
    expect(names("personal", "")).toEqual([
      "Mail",
      "Messages",
      "Notes",
      "Outlook",
      "Slack",
      "TextEdit",
      "WhatsApp",
      "Xcode",
      "Zoom",
    ]);
  });

  test.each<[string, string[]]>([
    ["Text", ["TextEdit"]],
    ["  text ", ["TextEdit"]],
    ["s", ["Slack", "Messages", "Notes", "WhatsApp"]],
    ["edit", ["TextEdit"]],
    ["chrome", []],
    ["safari", []],
    ["voice", []],
  ])("searching %j finds %j", (query, expected) => {
    expect(names("personal", query)).toEqual(expected);
  });

  test.each<[string, Category, ReturnType<typeof assigned>, string | null, boolean]>([
    ["a built-in app on its own tab", "work", assigned(), null, true],
    ["a built-in app on another tab", "personal", assigned(), "In Work messages", false],
    ["a moved built-in app on its new tab", "personal", slackToPersonal, null, true],
    [
      "a moved built-in app on its built-in tab",
      "work",
      slackToPersonal,
      "In Personal messages",
      false,
    ],
    [
      "an app the user put in Other",
      "email",
      assigned({
        kind: "app",
        bundleId: "com.tinyspeck.slackmacgap",
        name: "Slack",
        category: "other",
      }),
      "In Other",
      false,
    ],
  ])("Slack as %s: hint %j, here %j", (_, category, assignments, hint, here) => {
    const [slack] = pickerRows(category, apps, assignments, "slack");
    expect(slack && { hint: rowHint(slack, category), here: slack.current === category }).toEqual({
      hint,
      here,
    });
  });

  test("an app with no assignment and no built-in category has no hint on any tab", () => {
    for (const category of ["personal", "other"] as const) {
      const [textEdit] = pickerRows(category, apps, assigned(), "textedit");
      expect(textEdit && { hint: rowHint(textEdit, category), current: textEdit.current }).toEqual({
        hint: null,
        current: null,
      });
    }
  });
});

describe("siteInput", () => {
  const mailToWork = assigned({ kind: "site", host: "mail.example.com", category: "work" });
  test.each<[string, Category, ReturnType<typeof assigned>, SiteInput]>([
    ["", "email", assigned(), { kind: "empty" }],
    ["   ", "email", assigned(), { kind: "empty" }],
    [
      "https://Mail.Example.com/inbox?x=1",
      "email",
      assigned(),
      { kind: "add", host: "mail.example.com" as never, message: "Adds mail.example.com" },
    ],
    [
      "not a site",
      "email",
      assigned(),
      { kind: "invalid", message: "Enter a website like slack.com" },
    ],
    [
      "example.com/inbox",
      "email",
      assigned(),
      { kind: "invalid", message: "Enter a website like slack.com" },
    ],
    [
      "mail.example.com",
      "email",
      mailToWork,
      {
        kind: "add",
        host: "mail.example.com" as never,
        message: "Moves mail.example.com here from Work messages",
      },
    ],
    [
      "mail.example.com",
      "work",
      mailToWork,
      {
        kind: "add",
        host: "mail.example.com" as never,
        message: "mail.example.com is already in Work messages",
      },
    ],
    [
      "https://mail.google.com/mail/u/0",
      "email",
      assigned(),
      {
        kind: "add",
        host: "mail.google.com" as never,
        message: "mail.google.com is already in Email",
      },
    ],
    [
      "app.slack.com",
      "personal",
      assigned(),
      {
        kind: "add",
        host: "app.slack.com" as never,
        message: "Moves app.slack.com here from Work messages",
      },
    ],
  ])("%j on %s", (input, category, assignments, expected) => {
    expect(siteInput(input, category, assignments)).toEqual(expected);
  });
});

test("VOICE_BUNDLE_ID is the packaged app's id", () => {
  const yml = readFileSync(
    NodePath.join(import.meta.dirname, "../../electron-builder.yml"),
    "utf8",
  );
  const appId = /^appId:\s*(\S+)$/m.exec(yml)?.[1];
  expect(appId, "appId not found in apps/desktop/electron-builder.yml").toBeDefined();
  expect(VOICE_BUNDLE_ID).toBe(parseBundleId(appId ?? ""));
});

import type { CleanupStyle } from "@voice/cleanup/style";
import { describe, expect, test } from "vite-plus/test";

import {
  APP_CATEGORIES,
  BUILT_IN_APPS,
  BUILT_IN_SITES,
  SITE_CATEGORIES,
  parseBundleId,
  parseHost,
  type Category,
} from "./app-categories.ts";
import {
  classify,
  cleanupStyleFor,
  parseAssignments,
  parseTarget,
  type CategoryStyles,
} from "./style.ts";

const target = (bundleId: string | null, host: string | null = null) =>
  parseTarget({ bundleId, host });

describe("classify", () => {
  test.each<[string, ReturnType<typeof target>, Category]>([
    ["no target", null, "other"],
    ["a known app with no host", target("com.apple.mail"), "email"],
    ["a browser at a known site", target("com.google.Chrome", "mail.google.com"), "email"],
    ["a subdomain of a known site", target("com.google.Chrome", "app.slack.com"), "work"],
    ["a lookalike domain", target("com.google.Chrome", "notslack.com"), "other"],
    ["a domain that only ends in a known one's letters", target(null, "box.com"), "other"],
    ["a short known site", target(null, "x.com"), "personal"],
    ["a subdomain of a short known site", target(null, "mobile.x.com"), "personal"],
    ["an uppercase bundle id", target("COM.APPLE.MAIL"), "email"],
    ["an unknown app", target("com.example.Editor"), "other"],
  ])("%s", (_, given, category) => {
    expect(classify(given, [])).toBe(category);
  });

  test("a user site beats a user app for the same target", () => {
    const mine = parseAssignments([
      { kind: "app", bundleId: "com.google.Chrome", name: "Chrome", category: "work" },
      { kind: "site", host: "duckduckgo.com", category: "personal" },
    ]);
    expect(classify(target("com.google.Chrome", "duckduckgo.com"), mine)).toBe("personal");
  });

  test("a user app beats a built-in site", () => {
    const mine = parseAssignments([
      { kind: "app", bundleId: "com.google.Chrome", name: "Chrome", category: "work" },
    ]);
    expect(classify(target("com.google.Chrome", "mail.google.com"), mine)).toBe("work");
  });

  test("a user site beats a built-in app", () => {
    const mine = parseAssignments([{ kind: "site", host: "github.com", category: "work" }]);
    expect(classify(target("com.apple.mail", "github.com"), mine)).toBe("work");
  });

  test("a user assignment moves a built-in app", () => {
    const mine = parseAssignments([
      { kind: "app", bundleId: "com.apple.mail", name: "Mail", category: "work" },
    ]);
    expect(classify(target("com.apple.mail"), mine)).toBe("work");
  });

  test("the most specific user site wins whatever the list order", () => {
    const sites = [
      { kind: "site", host: "app.slack.com", category: "personal" },
      { kind: "site", host: "slack.com", category: "work" },
    ];
    const at = (host: string) => target("com.google.Chrome", host);
    for (const mine of [parseAssignments(sites), parseAssignments([...sites].reverse())]) {
      expect(classify(at("app.slack.com"), mine)).toBe("personal");
      expect(classify(at("team.app.slack.com"), mine)).toBe("personal");
      expect(classify(at("files.slack.com"), mine)).toBe("work");
    }
  });
});

describe("parseHost", () => {
  test.each([
    ["https://user:pw@Mail.Google.com:443/u/0?q#f", "mail.google.com"],
    ["Mail.Google.com.", "mail.google.com"],
    ["slack.com:8080", "slack.com"],
    ["  slack.com  ", "slack.com"],
    ["localhost", "localhost"],
    ["127.0.0.1", "127.0.0.1"],
    ["http://localhost:5173/", "localhost"],
  ])("%j is %j", (input, host) => {
    expect(parseHost(input)).toBe(host);
  });

  test.each([
    "",
    " ",
    "mail google.com",
    "a..b.com",
    ".com",
    "-a.com",
    "about:blank",
    "mailto:a@b.com",
    "münchen.de",
    "[::1]",
    "http://",
    "slack.com:",
    "user@slack.com",
    `${"a".repeat(64)}.com`,
  ])("%j is not a host", (input) => {
    expect(parseHost(input)).toBeNull();
  });

  test("accepts a 63-character label", () => {
    expect(parseHost(`${"a".repeat(63)}.com`)).toBe(`${"a".repeat(63)}.com`);
  });
});

describe("parseBundleId", () => {
  test("trims and lowercases", () => {
    expect(parseBundleId("  com.apple.MobileSMS ")).toBe("com.apple.mobilesms");
  });

  test.each(["", "   ", "com.apple mail", "com.äpple.mail", "Kom.apple.mail"])(
    "%j is not a bundle id",
    (input) => {
      expect(parseBundleId(input)).toBeNull();
    },
  );
});

describe("parseAssignments", () => {
  test("drops malformed items and keeps the last entry for a key, in lowercase", () => {
    expect(
      parseAssignments([
        { kind: "app", bundleId: "Com.Apple.Mail", name: " Mail ", category: "work" },
        { kind: "site", host: "Slack.com", category: "personal" },
        { kind: "site", host: "not a host", category: "work" },
        { kind: "site", host: "github.com", category: "shouty" },
        { kind: "app", bundleId: "com.example.App", category: "work" },
        { kind: "window", host: "github.com", category: "work" },
        "slack.com",
        null,
        { kind: "app", bundleId: "COM.APPLE.MAIL", name: "Mail", category: "personal" },
      ]),
    ).toEqual([
      { kind: "site", host: "slack.com", category: "personal" },
      { kind: "app", bundleId: "com.apple.mail", name: "Mail", category: "personal" },
    ]);
  });

  test.each([null, "slack.com", { kind: "site" }])("%j is no assignments", (raw) => {
    expect(parseAssignments(raw)).toEqual([]);
  });
});

describe("the built-in catalog", () => {
  test("every key is unique and already lowercase", () => {
    expect(APP_CATEGORIES.size).toBe(BUILT_IN_APPS.length);
    expect(SITE_CATEGORIES.size).toBe(BUILT_IN_SITES.length);
    for (const { bundleId } of BUILT_IN_APPS) expect(parseBundleId(bundleId)).toBe(bundleId);
    for (const { host } of BUILT_IN_SITES) expect(parseHost(host)).toBe(host);
  });

  test("lists no browser", () => {
    for (const browser of ["com.google.chrome", "com.apple.safari", "company.thebrowser.browser"]) {
      expect(BUILT_IN_APPS.map(({ bundleId }) => bundleId)).not.toContain(browser);
    }
  });
});

describe("cleanupStyleFor", () => {
  const styles: CategoryStyles = {
    personal: "veryCasual",
    work: "casual",
    email: "formal",
    other: "casual",
  };

  test.each<[Category, CleanupStyle]>([
    ["personal", { style: "veryCasual", layout: "general" }],
    ["work", { style: "casual", layout: "general" }],
    ["email", { style: "formal", layout: "email" }],
    ["other", { style: "casual", layout: "general" }],
  ])("%s cleans with %j", (category, expected) => {
    expect(cleanupStyleFor(category, styles)).toEqual(expected);
  });
});

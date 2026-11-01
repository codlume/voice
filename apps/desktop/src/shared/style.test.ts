import type { CleanupStyle } from "@voice/cleanup/style";
import { describe, expect, test } from "vite-plus/test";

import {
  APP_CATEGORIES,
  BUILT_IN_APPS,
  BUILT_IN_SITES,
  SITE_CATEGORIES,
  parseBundleId,
  parseBundleIds,
  parseHost,
  type Category,
} from "./app-categories.ts";
import {
  applyAssignmentEdit,
  classify,
  cleanupStyleFor,
  parseAssignmentEdit,
  parseAssignments,
  place,
  unassign,
  type Assignment,
  type CategoryStyles,
  type Target,
} from "./style.ts";

const target = (bundleId: string, host: string | null = null): Target => {
  const app = parseBundleId(bundleId);
  if (app === null) throw new Error(`not a bundle id: ${bundleId}`);
  return { bundleId: app, host: host === null ? null : parseHost(host) };
};

describe("classify", () => {
  test.each<[string, Target | null, Category]>([
    ["no target", null, "other"],
    ["a known app with no host", target("com.apple.mail"), "email"],
    ["a browser at a known site", target("com.google.Chrome", "mail.google.com"), "email"],
    ["a subdomain of a known site", target("com.google.Chrome", "app.slack.com"), "work"],
    ["a lookalike domain", target("com.google.Chrome", "notslack.com"), "other"],
    [
      "a domain that only ends in a known one's letters",
      target("com.google.Chrome", "box.com"),
      "other",
    ],
    ["a short known site", target("com.google.Chrome", "x.com"), "personal"],
    ["a subdomain of a short known site", target("com.google.Chrome", "mobile.x.com"), "personal"],
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
    for (const mine of [parseAssignments(sites), parseAssignments(sites.toReversed())]) {
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
    ["http://localhost:5173/", "localhost"],
    ["http://slack.com\\@evil.com", "slack.com"],
    ["https://Mail.Example.com/inbox?x=1", "mail.example.com"],
    ["HTTPS://WWW.EXAMPLE.COM/a/b?c=d#e", "www.example.com"],
    ["www.example.com", "www.example.com"],
    ["http://ada@www.example.com:8443/", "www.example.com"],
  ])("%j is %j", (input, host) => {
    expect(parseHost(input)).toBe(host);
  });

  test.each([
    "",
    " ",
    "mail google.com",
    "not a site",
    "example.com/inbox",
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
    "127.0.0.1",
    "http://127.1:5173/",
    "2130706433",
    "0x7f000001",
    "0x7f.0x1",
    "http://0X7F.1/",
    "example.0x",
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

  test.each(["com.readdle.smartemail-Mac", "com.example.my_app", "a"])(
    "%j is a bundle id",
    (input) => {
      expect(parseBundleId(input)).toBe(input.toLowerCase());
    },
  );

  test.each([
    "",
    "   ",
    "com.apple mail",
    "com.äpple.mail",
    "Kom.apple.mail",
    "com.apple/mail",
    "com.apple.mail!",
    "com..apple.mail",
    ".com.apple.mail",
    "com.apple.mail.",
    "com:apple:mail",
  ])("%j is not a bundle id", (input) => {
    expect(parseBundleId(input)).toBeNull();
  });
});

describe("parseBundleIds", () => {
  test("keeps the bundle ids of an untrusted list and drops the rest", () => {
    expect(parseBundleIds(["com.apple.Mail", 7, "com.apple/mail", null, " a.b "])).toEqual([
      "com.apple.mail",
      "a.b",
    ]);
  });

  test.each([undefined, null, "com.apple.mail", { 0: "com.apple.mail" }])(
    "%j is not a list",
    (raw) => {
      expect(parseBundleIds(raw)).toEqual([]);
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
        { kind: "app", bundleId: "com.example.Blank", name: "   ", category: "work" },
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

const list = (...items: unknown[]) => parseAssignments(items);

describe("place and unassign", () => {
  const textEdit = (category: Category) =>
    list({
      kind: "app",
      bundleId: "com.apple.TextEdit",
      name: "TextEdit",
      category,
    })[0] as Assignment;
  const slack = (category: Category) =>
    list({
      kind: "app",
      bundleId: "com.tinyspeck.slackmacgap",
      name: "Slack",
      category,
    })[0] as Assignment;
  const site = (host: string, category: Category) =>
    list({ kind: "site", host, category })[0] as Assignment;

  test.each<[string, Assignment[], Assignment, Assignment[]]>([
    ["adds an unknown app", [], textEdit("personal"), [textEdit("personal")]],
    ["adds an unknown app to Other", [], textEdit("other"), [textEdit("other")]],
    [
      "moves an assigned app, keeping one entry",
      [site("linear.app", "work"), textEdit("personal")],
      textEdit("email"),
      [site("linear.app", "work"), textEdit("email")],
    ],
    ["moves a built-in app to another category", [], slack("personal"), [slack("personal")]],
    ["adds nothing for a built-in app picked into its own category", [], slack("work"), []],
    [
      "sends a moved built-in app back by dropping its entry",
      [slack("personal")],
      slack("work"),
      [],
    ],
    ["adds a site", [], site("mail.example.com", "email"), [site("mail.example.com", "email")]],
    [
      "moves an assigned site",
      [site("mail.example.com", "work")],
      site("mail.example.com", "email"),
      [site("mail.example.com", "email")],
    ],
    [
      "adds nothing for a built-in site in its own category",
      [],
      site("mail.google.com", "email"),
      [],
    ],
    ["adds nothing for a subdomain of a built-in site", [], site("app.slack.com", "work"), []],
    [
      "moves a built-in site",
      [],
      site("app.slack.com", "personal"),
      [site("app.slack.com", "personal")],
    ],
    [
      "adds a subdomain the user's own parent site would send elsewhere",
      [site("slack.com", "personal")],
      site("app.slack.com", "work"),
      [site("slack.com", "personal"), site("app.slack.com", "work")],
    ],
  ])("%s", (_, before, assignment, after) => {
    expect(place(before, assignment)).toEqual(after);
  });

  test("returns the same list when nothing changes", () => {
    const before = [textEdit("personal")];
    expect(place(before, textEdit("personal"))).toBe(before);
    expect(place([], slack("work"))).toEqual([]);
  });

  test("an app and a site never collide, and unassign removes only its own key", () => {
    const both = place([textEdit("personal")], site("textedit.example", "personal"));
    expect(both).toEqual([textEdit("personal"), site("textedit.example", "personal")]);
    expect(unassign(both, textEdit("work"))).toEqual([site("textedit.example", "personal")]);
    expect(
      classify(
        target("com.tinyspeck.slackmacgap"),
        unassign([slack("personal")], slack("personal")),
      ),
    ).toBe("work");
  });

  test("a pick that looks redundant against an old list still applies to the current one", () => {
    const inWork = { ...textEdit("personal"), category: "work" as const };
    const seenByPage = [textEdit("personal")];
    expect(place(seenByPage, textEdit("personal"))).toBe(seenByPage);
    const onDisk = applyAssignmentEdit(seenByPage, { op: "place", assignment: inWork });
    expect(applyAssignmentEdit(onDisk, { op: "place", assignment: textEdit("personal") })).toEqual([
      textEdit("personal"),
    ]);
  });
});

describe("parseAssignmentEdit", () => {
  test.each<[string, unknown]>([
    ["no op", { assignment: { kind: "site", host: "slack.com", category: "work" } }],
    [
      "an unknown op",
      { op: "replace", assignment: { kind: "site", host: "slack.com", category: "work" } },
    ],
    [
      "a bad host",
      { op: "place", assignment: { kind: "site", host: "not a site", category: "work" } },
    ],
    [
      "a bad category",
      { op: "place", assignment: { kind: "site", host: "slack.com", category: "shouty" } },
    ],
    ["not an object", "slack.com"],
    ["null", null],
  ])("refuses an edit with %s", (_, raw) => {
    expect(parseAssignmentEdit(raw)).toBeNull();
  });

  test("parses a valid edit into branded keys", () => {
    expect(
      parseAssignmentEdit({
        op: "unassign",
        assignment: {
          kind: "app",
          bundleId: "com.apple.TextEdit",
          name: " TextEdit ",
          category: "personal",
        },
      }),
    ).toEqual({
      op: "unassign",
      assignment: {
        kind: "app",
        bundleId: "com.apple.textedit",
        name: "TextEdit",
        category: "personal",
      },
    });
  });
});

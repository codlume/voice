import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { FEED_URL, formatSize, loadRelease, parseFeed } from "./release.ts";

const zip = `  - url: https://downloads.voice.codlume.com/releases/0.2.0/mac-arm64/Voice-0.2.0-arm64-mac.zip
    sha512: c2hhNTEyLXppcA==
    size: 175546848`;

const dmg = (url: string, size = "180251104") => `  - url: ${url}
    sha512: c2hhNTEyLWRtZw==
    size: ${size}`;

const feed = (...files: string[]) => `version: 0.2.0
files:
${files.join("\n")}
path: https://downloads.voice.codlume.com/releases/0.2.0/mac-arm64/Voice-0.2.0-arm64-mac.zip
sha512: c2hhNTEyLXppcA==
releaseDate: 2026-09-26T13:16:36.038Z
`;

const dmgUrl = "https://downloads.voice.codlume.com/releases/0.2.0/mac-arm64/Voice-0.2.0-arm64.dmg";

describe("parseFeed", () => {
  it("reads the DMG from the current feed shape", () => {
    expect(parseFeed(feed(zip, dmg(dmgUrl)))).toEqual({
      version: "0.2.0",
      dmgUrl,
      size: 180251104,
    });
  });

  it("rejects a feed with only a zip", () => {
    expect(parseFeed(feed(zip))).toBeNull();
  });

  it("rejects malformed YAML", () => {
    expect(parseFeed("version: 0.2.0\nfiles: [\n  - url: :")).toBeNull();
  });

  it("rejects a DMG served over http", () => {
    expect(parseFeed(feed(zip, dmg(dmgUrl.replace("https:", "http:"))))).toBeNull();
  });

  it("rejects a non-integer size", () => {
    expect(parseFeed(feed(dmg(dmgUrl, "180.5")))).toBeNull();
  });

  it("rejects a feed without a version", () => {
    expect(parseFeed(feed(dmg(dmgUrl)).replace("version: 0.2.0\n", ""))).toBeNull();
  });
});

describe("loadRelease", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the stable feed", async () => {
    const fetch = vi.fn(async () => new Response(feed(zip, dmg(dmgUrl))));
    vi.stubGlobal("fetch", fetch);
    expect(await loadRelease()).toEqual({ version: "0.2.0", dmgUrl, size: 180251104 });
    expect(fetch).toHaveBeenCalledWith(FEED_URL, expect.anything());
  });

  it("returns null when the feed request fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect(await loadRelease()).toBeNull();
  });

  it("returns null when the feed responds with an error", async () => {
    vi.stubGlobal("fetch", async () => new Response(feed(zip, dmg(dmgUrl)), { status: 404 }));
    expect(await loadRelease()).toBeNull();
  });
});

describe("formatSize", () => {
  it("rounds to decimal megabytes", () => {
    expect(formatSize(180251104)).toBe("180 MB");
  });
});

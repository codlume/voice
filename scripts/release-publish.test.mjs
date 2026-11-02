import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { notesSinceInstalled } from "../apps/desktop/src/main/release-notes.ts";
import { compareVersions, nightlyVersion } from "./release-version.mjs";
import { preflightRelease, publishRelease } from "./release-publish.mjs";

const hash = (bytes) => createHash("sha512").update(bytes).digest("base64");
const baseUrl = "https://downloads.example.test";

function fixture(version, marker = version) {
  const zip = Buffer.from(`zip:${marker}`);
  const dmg = Buffer.from(`dmg:${marker}`);
  const artifacts = new Map([
    [`Voice-${version}-arm64.zip`, zip],
    [`Voice-${version}-arm64.dmg`, dmg],
  ]);
  const builderFeed = `version: ${version}
files:
  - url: Voice-${version}-arm64.zip
    sha512: ${hash(zip)}
    size: ${zip.length}
  - url: Voice-${version}-arm64.dmg
    sha512: ${hash(dmg)}
    size: ${dmg.length}
path: Voice-${version}-arm64.zip
sha512: ${hash(zip)}
releaseDate: '2026-09-26T00:00:00.000Z'
`;
  return { version, artifacts, builderFeed };
}

function memoryStore() {
  const objects = new Map();
  return {
    objects,
    async get(key) {
      return objects.get(key) ?? null;
    },
    // Typed like the real store's put so tests can wrap it and forward the options.
    /** @type {(key: string, bytes: Uint8Array, options?: { cache?: string, contentType?: string }) => Promise<void>} */
    async put(key, bytes) {
      objects.set(key, Buffer.from(bytes));
    },
  };
}

test("nightly versions use the next patch, UTC date, and run number", () => {
  assert.equal(nightlyVersion("0.0.1", "20260926", 184), "0.0.2-nightly.20260926.184");
  assert.equal(nightlyVersion("1.4.0", "20261231", 185), "1.4.1-nightly.20261231.185");
  assert.throws(() => nightlyVersion("1.4.0", "2026-12-31", 185), /YYYYMMDD/);
  assert.equal(compareVersions("1.4.1-nightly.20260926.185", "1.4.1"), -1);
  assert.equal(compareVersions("1.4.1-nightly.20260926.186", "1.4.1-nightly.20260926.185"), 1);
  assert.equal(compareVersions("1.4.1-nightly.20260927.1", "1.4.1-nightly.20260926.185"), 1);
  assert.equal(compareVersions("1.4.1-nightly.20260926.185", "1.4.1-nightly.20260926.185"), 0);
});

test("dated nightlies supersede the legacy run-number nightly on the feed", () => {
  assert.equal(compareVersions("0.1.1-nightly.20260927.4", "0.1.1-nightly.3"), 1);
  assert.equal(compareVersions("0.1.1-nightly.3", "0.1.1-nightly.20260927.4"), -1);
  assert.equal(compareVersions("0.1.1-nightly.4", "0.1.1-nightly.3"), 1);
});

test("publishes artifacts first, then promotes a verified feed", async () => {
  const store = memoryStore();
  const release = fixture("0.0.2-nightly.184");
  const result = await publishRelease({ store, channel: "nightly", baseUrl, ...release });
  assert.equal(result, "published");
  const feed = store.objects.get("channels/nightly/mac-arm64/latest-mac.yml").toString();
  assert.match(
    feed,
    /https:\/\/downloads\.example\.test\/releases\/0\.0\.2-nightly\.184\/mac-arm64\/Voice-/,
  );
  assert.match(
    feed,
    /path: https:\/\/downloads\.example\.test\/releases\/0\.0\.2-nightly\.184\/mac-arm64\/Voice-/,
  );
  assert.equal(store.objects.size, 3);
  assert.equal(
    await publishRelease({ store, channel: "nightly", baseUrl, ...release }),
    "already-published",
  );
  assert.equal(
    await publishRelease({ store, channel: "nightly", baseUrl, ...fixture("0.0.2-nightly.183") }),
    "skipped-older",
  );
});

test("the feed carries release notes, and a rerun with edited notes is already published", async () => {
  const store = memoryStore();
  const release = fixture("0.0.2");
  const releaseNotes =
    "## What's Changed\n* feat: add a setting by @someone in https://github.com/codlume/voice/pull/120\n";
  assert.equal(
    await publishRelease({ store, channel: "stable", baseUrl, ...release, releaseNotes }),
    "published",
  );
  const key = "channels/stable/mac-arm64/latest-mac.yml";
  const published = store.objects.get(key);
  assert.equal(parse(published.toString()).releaseNotes, releaseNotes);
  assert.equal(
    await publishRelease({
      store,
      channel: "stable",
      baseUrl,
      ...release,
      releaseNotes: "## What's Changed\n* edited after release\n",
    }),
    "already-published",
  );
  assert.equal(store.objects.get(key), published);
});

const stableFeed = (store) =>
  parse(store.objects.get("channels/stable/mac-arm64/latest-mac.yml").toString());

async function publishStable(store, version, releaseNotes) {
  return publishRelease({ store, channel: "stable", baseUrl, ...fixture(version), releaseNotes });
}

test("the feed carries the notes of earlier releases, newest first", async () => {
  const store = memoryStore();
  await publishStable(store, "0.0.2", "* two\n");
  await publishStable(store, "0.0.3", "* three\n");
  await publishStable(store, "0.0.4", "* four\n");
  const feed = stableFeed(store);
  assert.equal(feed.releaseNotes, "* four\n");
  assert.deepEqual(feed.releaseHistory, [
    { version: "0.0.4", notes: "* four\n" },
    { version: "0.0.3", notes: "* three\n" },
    { version: "0.0.2", notes: "* two\n" },
  ]);
});

test("the history starts from a feed published before it existed", async () => {
  const store = memoryStore();
  await publishStable(store, "0.0.2", "* two\n");
  const key = "channels/stable/mac-arm64/latest-mac.yml";
  const legacy = stableFeed(store);
  delete legacy.releaseHistory;
  store.objects.set(key, Buffer.from(stringify(legacy)));
  await publishStable(store, "0.0.3", "* three\n");
  assert.deepEqual(stableFeed(store).releaseHistory, [
    { version: "0.0.3", notes: "* three\n" },
    { version: "0.0.2", notes: "* two\n" },
  ]);
});

test("releases without notes stay in the history", async () => {
  const store = memoryStore();
  await publishStable(store, "0.0.2", "");
  await publishStable(store, "0.0.3", "* three\n");
  await publishStable(store, "0.0.4", "  \n");
  assert.deepEqual(stableFeed(store).releaseHistory, [
    { version: "0.0.4", notes: "" },
    { version: "0.0.3", notes: "* three\n" },
    { version: "0.0.2", notes: "" },
  ]);
});

test("the history drops carried releases that are not older than the new one, or repeat", async () => {
  const store = memoryStore();
  await publishStable(store, "0.0.3", "* three\n");
  const key = "channels/stable/mac-arm64/latest-mac.yml";
  const edited = stableFeed(store);
  edited.releaseHistory = [
    { version: "0.0.5", notes: "* rolled back\n" },
    { version: "0.0.4", notes: "* same as new\n" },
    { version: "0.0.1", notes: "* one\n" },
    { version: "0.0.3", notes: "* three\n" },
    { version: "0.0.3", notes: "* three again\n" },
    { version: "three", notes: "* bogus\n" },
    { version: "0.0.2", notes: "* two\n" },
  ];
  store.objects.set(key, Buffer.from(stringify(edited)));
  await publishStable(store, "0.0.4", "* four\n");
  assert.deepEqual(stableFeed(store).releaseHistory, [
    { version: "0.0.4", notes: "* four\n" },
    { version: "0.0.3", notes: "* three\n" },
    { version: "0.0.2", notes: "* two\n" },
    { version: "0.0.1", notes: "* one\n" },
  ]);
});

test("the desktop app reads the notes the publisher writes", async () => {
  const store = memoryStore();
  await publishStable(store, "0.0.2", "* two\n");
  await publishStable(store, "0.0.3", "");
  await publishStable(store, "0.0.4", "* four\n");
  await publishStable(store, "0.0.5", "* five\n");
  const feed = stableFeed(store);
  assert.deepEqual(notesSinceInstalled(feed, "0.0.2"), {
    releases: [
      { version: "0.0.5", items: ["five"] },
      { version: "0.0.4", items: ["four"] },
    ],
    more: false,
  });
  assert.deepEqual(notesSinceInstalled(feed, "0.0.3"), {
    releases: [
      { version: "0.0.5", items: ["five"] },
      { version: "0.0.4", items: ["four"] },
    ],
    more: false,
  });
  assert.deepEqual(notesSinceInstalled(feed, "0.0.5"), { releases: [], more: false });
});

test("the history keeps the ten newest releases", async () => {
  const store = memoryStore();
  for (let patch = 1; patch <= 12; patch += 1)
    await publishStable(store, `0.0.${patch}`, `* ${patch}\n`);
  const history = stableFeed(store).releaseHistory;
  assert.equal(history.length, 10);
  assert.equal(history[0].version, "0.0.12");
  assert.equal(history.at(-1).version, "0.0.3");
});

test("republishing the current version leaves its history alone", async () => {
  const store = memoryStore();
  await publishStable(store, "0.0.2", "* two\n");
  await publishStable(store, "0.0.3", "* three\n");
  const published = store.objects.get("channels/stable/mac-arm64/latest-mac.yml");
  assert.equal(await publishStable(store, "0.0.3", "* three, edited\n"), "already-published");
  assert.equal(store.objects.get("channels/stable/mac-arm64/latest-mac.yml"), published);
});

test("blank release notes leave the feed without a releaseNotes key", async () => {
  for (const releaseNotes of [undefined, "", "  \n"]) {
    const store = memoryStore();
    await publishRelease({ store, channel: "stable", baseUrl, ...fixture("0.0.2"), releaseNotes });
    const feed = parse(store.objects.get("channels/stable/mac-arm64/latest-mac.yml").toString());
    assert.equal(Object.hasOwn(feed, "releaseNotes"), false);
  }
});

test("a version cannot be replaced with different bytes", async () => {
  const store = memoryStore();
  await publishRelease({ store, channel: "nightly", baseUrl, ...fixture("0.0.2-nightly.184") });
  await assert.rejects(
    publishRelease({
      store,
      channel: "nightly",
      baseUrl,
      ...fixture("0.0.2-nightly.184", "changed"),
    }),
    /different artifact checksums/,
  );
  store.objects.delete("channels/nightly/mac-arm64/latest-mac.yml");
  await assert.rejects(
    publishRelease({
      store,
      channel: "nightly",
      baseUrl,
      ...fixture("0.0.2-nightly.184", "changed"),
    }),
    /Immutable artifact collision/,
  );
});

test("builder feed checks DMG bytes before publication", async () => {
  const store = memoryStore();
  const release = fixture("0.0.2");
  await publishRelease({ store, channel: "stable", baseUrl, ...release });
  const changed = fixture("0.0.2");
  changed.artifacts.set("Voice-0.0.2-arm64.dmg", Buffer.from("different dmg"));
  await assert.rejects(
    publishRelease({ store, channel: "stable", baseUrl, ...changed }),
    /Builder checksum or size mismatch/,
  );
});

test("preflight skips an equal version only while published artifacts match the feed", async () => {
  const store = memoryStore();
  const version = "0.0.2";
  const release = fixture(version);
  const args = { store, channel: "stable", version, baseUrl };
  assert.equal(await preflightRelease(args), false);
  await publishRelease({ ...args, ...release });
  assert.equal(await preflightRelease(args), true);

  const dmgKey = `releases/${version}/mac-arm64/Voice-${version}-arm64.dmg`;
  const original = store.objects.get(dmgKey);
  store.objects.delete(dmgKey);
  await assert.rejects(preflightRelease(args), /Published artifact is missing or corrupt: .*\.dmg/);
  store.objects.set(dmgKey, Buffer.from("corrupt"));
  await assert.rejects(preflightRelease(args), /Published artifact is missing or corrupt: .*\.dmg/);
  store.objects.set(dmgKey, original);
  assert.equal(await preflightRelease(args), true);
  assert.equal(await preflightRelease({ ...args, version: "0.0.1" }), true);
  assert.equal(await preflightRelease({ ...args, version: "0.0.3" }), false);
});

test("preflight rejects an equal-version feed without both installer formats", async () => {
  const store = memoryStore();
  const version = "0.0.2";
  const release = fixture(version);
  await publishRelease({ store, channel: "stable", baseUrl, ...release });
  const key = "channels/stable/mac-arm64/latest-mac.yml";
  const zipOnly = store.objects
    .get(key)
    .toString()
    .replace(/  - url: .*\.dmg\n    sha512: .*\n    size: \d+\n/, "");
  store.objects.set(key, Buffer.from(zipOnly));
  await assert.rejects(
    preflightRelease({ store, channel: "stable", version, baseUrl }),
    /Release feed requires ZIP and DMG/,
  );
});

test("publisher rejects malformed release URLs and feeds without a DMG entry", async () => {
  const release = fixture("0.0.2");
  for (const invalid of [
    "https://user:password@downloads.example.test",
    "https://downloads.example.test/?token=secret",
    "https://downloads.example.test/#fragment",
    "http://downloads.example.test",
  ]) {
    await assert.rejects(
      publishRelease({ store: memoryStore(), channel: "stable", baseUrl: invalid, ...release }),
      /Expected HTTPS release base URL/,
    );
  }
  const zipOnly = release.builderFeed.replace(
    /  - url: .*\.dmg\n    sha512: .*\n    size: \d+\n/,
    "",
  );
  await assert.rejects(
    publishRelease({
      store: memoryStore(),
      channel: "stable",
      baseUrl,
      ...release,
      builderFeed: zipOnly,
    }),
    /Release feed requires ZIP and DMG/,
  );
});

test("missing or corrupt artifact leaves previous feed in place", async () => {
  const store = memoryStore();
  await publishRelease({ store, channel: "nightly", baseUrl, ...fixture("0.0.2-nightly.184") });
  const key = "channels/nightly/mac-arm64/latest-mac.yml";
  const before = store.objects.get(key);
  const missing = fixture("0.0.2-nightly.185");
  missing.artifacts.delete("Voice-0.0.2-nightly.185-arm64.zip");
  await assert.rejects(
    publishRelease({ store, channel: "nightly", baseUrl, ...missing }),
    /requires ZIP/,
  );
  assert.equal(store.objects.get(key), before);
  const bad = fixture("0.0.2-nightly.185");
  bad.artifacts.set("Voice-0.0.2-nightly.185-arm64.zip", Buffer.from("bad"));
  await assert.rejects(
    publishRelease({ store, channel: "nightly", baseUrl, ...bad }),
    /checksum or size mismatch/,
  );
  assert.equal(store.objects.get(key), before);
});

test("upload verification failure never promotes the feed", async () => {
  const store = memoryStore();
  const put = store.put;
  store.put = async (key, bytes, options) => {
    await put(key, bytes, options);
    if (key.endsWith(".zip")) store.objects.set(key, Buffer.from("truncated"));
  };
  await assert.rejects(
    publishRelease({ store, channel: "stable", baseUrl, ...fixture("0.0.2") }),
    /verification failed/,
  );
  assert.equal(store.objects.has("channels/stable/mac-arm64/latest-mac.yml"), false);
});

test("failed feed write preserves the previous promotion", async () => {
  const store = memoryStore();
  await publishRelease({ store, channel: "stable", baseUrl, ...fixture("0.0.2") });
  const key = "channels/stable/mac-arm64/latest-mac.yml";
  const previous = store.objects.get(key);
  const put = store.put;
  store.put = async (path, bytes, options) => {
    if (path === key) throw new Error("feed PUT interrupted");
    return put(path, bytes, options);
  };
  await assert.rejects(
    publishRelease({ store, channel: "stable", baseUrl, ...fixture("0.0.3") }),
    /feed PUT interrupted/,
  );
  assert.equal(store.objects.get(key), previous);
});

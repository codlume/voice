import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parse, stringify } from "yaml";
import { compareVersions, parseVersion } from "./release-version.mjs";

const sha512 = (bytes) => createHash("sha512").update(bytes).digest("base64");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function readFeed(source) {
  const feed = parse(source, { uniqueKeys: true });
  if (
    !feed ||
    typeof feed !== "object" ||
    typeof feed.version !== "string" ||
    !Array.isArray(feed.files) ||
    feed.files.length === 0
  ) {
    throw new Error("Invalid builder feed");
  }
  parseVersion(feed.version);
  return feed;
}

function artifactName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._ -]*\.(zip|dmg|blockmap)$/.test(name)) {
    throw new Error(`Unsafe artifact name: ${name}`);
  }
  return name;
}

export function releaseBaseUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error();
    return url.href.replace(/\/$/, "");
  } catch {
    throw new Error("Expected HTTPS release base URL without credentials, query, or fragment");
  }
}

function requireInstallerFiles(names) {
  if (
    !names.some((name) => name.endsWith(".zip")) ||
    !names.some((name) => name.endsWith(".dmg"))
  ) {
    throw new Error("Release feed requires ZIP and DMG artifacts");
  }
}

export function prepareFeed(source, version, baseUrl, artifacts, releaseNotes) {
  const feed = readFeed(source);
  if (feed.version !== version)
    throw new Error("Builder feed version differs from artifact version");
  if (
    ![...artifacts.keys()].some((name) => name.endsWith(".zip")) ||
    ![...artifacts.keys()].some((name) => name.endsWith(".dmg"))
  ) {
    throw new Error("Release requires ZIP, DMG, and an updater URL");
  }
  for (const name of artifacts.keys()) artifactName(name);
  requireInstallerFiles(feed.files.map((item) => artifactName(item?.url)));
  for (const item of feed.files) {
    if (!item || typeof item !== "object") throw new Error("Invalid builder feed file");
    const name = artifactName(item.url);
    const bytes = artifacts.get(name);
    if (!bytes) throw new Error(`Feed references missing artifact: ${name}`);
    if (
      typeof item.sha512 !== "string" ||
      !Number.isSafeInteger(item.size) ||
      sha512(bytes) !== item.sha512 ||
      bytes.length !== item.size
    ) {
      throw new Error(`Builder checksum or size mismatch: ${name}`);
    }
    item.url = `${baseUrl}/releases/${version}/mac-arm64/${encodeURIComponent(name)}`;
  }
  if (feed.path !== undefined) {
    const name = artifactName(feed.path);
    const bytes = artifacts.get(name);
    if (!bytes || feed.sha512 !== sha512(bytes)) {
      throw new Error("Legacy feed path checksum mismatch");
    }
    feed.path = `${baseUrl}/releases/${version}/mac-arm64/${encodeURIComponent(name)}`;
  }
  if (releaseNotes.trim()) feed.releaseNotes = releaseNotes;
  return stringify(feed);
}

function feedIdentity(source) {
  const feed = readFeed(source);
  const files = feed.files
    .map((item) => {
      if (
        typeof item?.url !== "string" ||
        typeof item?.sha512 !== "string" ||
        !Number.isSafeInteger(item.size)
      )
        throw new Error("Invalid published feed file");
      return `${item.url}:${item.sha512}:${item.size}`;
    })
    .toSorted();
  return { version: feed.version, hashes: files.join(",") };
}

export async function preflightRelease({ store, channel, version, baseUrl }) {
  parseVersion(version);
  if (!["stable", "nightly"].includes(channel)) throw new Error("Invalid release channel");
  const url = releaseBaseUrl(baseUrl);
  const source = await store.get(`channels/${channel}/mac-arm64/latest-mac.yml`);
  if (!source) return false;
  const feed = readFeed(source.toString());
  const order = compareVersions(feed.version, version);
  if (order < 0) return false;
  if (order > 0) return true;
  const names = feed.files.map((item) => {
    if (typeof item?.url !== "string") throw new Error("Invalid published feed file");
    let name;
    try {
      name = artifactName(decodeURIComponent(new URL(item.url).pathname.split("/").at(-1)));
    } catch {
      throw new Error(`Invalid published artifact URL: ${item.url}`);
    }
    const expected = `${url}/releases/${version}/mac-arm64/${encodeURIComponent(name)}`;
    if (item.url !== expected) throw new Error(`Unexpected published artifact URL: ${item.url}`);
    return name;
  });
  requireInstallerFiles(names);
  for (let index = 0; index < feed.files.length; index += 1) {
    const item = feed.files[index];
    const name = names[index];
    const key = `releases/${version}/mac-arm64/${name}`;
    const bytes = await store.get(key);
    if (!bytes || bytes.length !== item.size || sha512(bytes) !== item.sha512) {
      throw new Error(`Published artifact is missing or corrupt: ${key}`);
    }
  }
  return true;
}

export async function publishRelease({
  store,
  channel,
  version,
  baseUrl,
  artifacts,
  builderFeed,
  releaseNotes = "",
}) {
  parseVersion(version);
  if (
    !["stable", "nightly"].includes(channel) ||
    (channel === "stable") !== (parseVersion(version).nightly === null)
  ) {
    throw new Error("Invalid release channel and version");
  }
  const url = releaseBaseUrl(baseUrl);
  const feed = prepareFeed(builderFeed, version, url, artifacts, releaseNotes);
  const feedKey = `channels/${channel}/mac-arm64/latest-mac.yml`;
  // GitHub Actions serializes promotion per channel. Re-read under that lock.
  const prior = await store.get(feedKey);
  let alreadyPublished = false;
  if (prior) {
    const old = feedIdentity(prior.toString());
    const next = feedIdentity(feed);
    const order = compareVersions(version, old.version);
    if (order < 0) return "skipped-older";
    if (order === 0) {
      if (old.hashes !== next.hashes)
        throw new Error("Same release version has different artifact checksums");
      alreadyPublished = true;
    }
  }
  for (const [name, bytes] of artifacts) {
    const key = `releases/${version}/mac-arm64/${name}`;
    const remote = await store.get(key);
    if (remote && !remote.equals(bytes)) throw new Error(`Immutable artifact collision: ${key}`);
    if (alreadyPublished && !remote) throw new Error(`Published artifact is missing: ${key}`);
    if (!remote) await store.put(key, bytes, { cache: "public, max-age=31536000, immutable" });
    const verified = await store.get(key);
    if (!verified || verified.length !== bytes.length || sha256(verified) !== sha256(bytes)) {
      throw new Error(`Artifact verification failed: ${key}`);
    }
  }
  if (alreadyPublished) return "already-published";
  await store.put(feedKey, Buffer.from(feed), { cache: "no-store", contentType: "text/yaml" });
  const promoted = await store.get(feedKey);
  if (!promoted?.equals(Buffer.from(feed))) throw new Error("Feed verification failed");
  return "published";
}

function aws(args, input) {
  const endpoint = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  return execFileSync("aws", ["--endpoint-url", endpoint, "s3api", ...args], {
    input,
    maxBuffer: 1024 * 1024 * 1024,
    env: { ...process.env, AWS_DEFAULT_REGION: "auto" },
  });
}

export function r2Store(bucket) {
  return {
    async get(key) {
      try {
        // get-object writes to a file. Use a unique file to avoid stdout protocol quirks.
        const path = join(
          process.env.RUNNER_TEMP || "/tmp",
          `voice-r2-${process.pid}-${Math.random().toString(16).slice(2)}`,
        );
        try {
          aws(["get-object", "--bucket", bucket, "--key", key, path]);
          return readFileSync(path);
        } finally {
          await import("node:fs/promises").then(({ rm }) => rm(path, { force: true }));
        }
      } catch (error) {
        if (/NoSuchKey|404|Not Found/.test(String(error.stderr || error))) return null;
        throw error;
      }
    },
    async put(key, bytes, { cache, contentType = "application/octet-stream" }) {
      const path = join(
        process.env.RUNNER_TEMP || "/tmp",
        `voice-r2-${process.pid}-${Math.random().toString(16).slice(2)}`,
      );
      try {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(path, bytes);
        aws([
          "put-object",
          "--bucket",
          bucket,
          "--key",
          key,
          "--body",
          path,
          "--cache-control",
          cache,
          "--content-type",
          contentType,
        ]);
      } finally {
        await import("node:fs/promises").then(({ rm }) => rm(path, { force: true }));
      }
    },
  };
}

if (process.argv[1]?.endsWith("/release-publish.mjs")) {
  const {
    RELEASE_CHANNEL: channel,
    RELEASE_VERSION: version,
    RELEASE_BASE_URL: baseUrl,
    R2_BUCKET: bucket,
    R2_ACCOUNT_ID: account,
    RELEASE_NOTES_FILE: notesFile,
  } = process.env;
  if (!bucket || !account || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("R2 bucket, account, and AWS-compatible credentials are required");
  }
  const dir = "apps/desktop/release";
  const names = readdirSync(dir).filter((name) => /\.(zip|dmg|blockmap)$/.test(name));
  const artifacts = new Map(names.map((name) => [basename(name), readFileSync(join(dir, name))]));
  const builderFeed = readFileSync(join(dir, "latest-mac.yml"), "utf8");
  const releaseNotes = notesFile ? readFileSync(notesFile, "utf8") : "";
  console.log(
    await publishRelease({
      store: r2Store(bucket),
      channel,
      version,
      baseUrl,
      artifacts,
      builderFeed,
      releaseNotes,
    }),
  );
}

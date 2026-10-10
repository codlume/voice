import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appBuilderRequire, checkPackagedApp } from "./release-check-app.mjs";
import { parseVersion } from "./release-version.mjs";
import { releaseBaseUrl } from "./release-publish.mjs";

const channel = process.env.RELEASE_CHANNEL;
const version = process.env.RELEASE_VERSION;
const baseUrl = releaseBaseUrl(process.env.RELEASE_BASE_URL);
if (!["stable", "nightly"].includes(channel) || !version) {
  throw new Error("RELEASE_CHANNEL, RELEASE_VERSION and HTTPS RELEASE_BASE_URL are required");
}
if ((channel === "stable") !== (parseVersion(version).nightly === null)) {
  throw new Error("Release version does not match channel");
}

const desktop = resolve("apps/desktop");
const config = {
  extends: "./electron-builder.yml",
  extraMetadata: {
    version,
    voiceRelease: { channel, updateUrl: baseUrl },
  },
  mac: { notarize: true },
  publish: [
    { provider: "generic", url: `${baseUrl}/channels/${channel}/mac-arm64`, channel: "latest" },
  ],
};
const configFile = join(desktop, "release-config.json");
writeFileSync(configFile, JSON.stringify(config));
// Debug IDs have to be injected before electron-builder packs the bundles, so the shipped files
// match the uploaded maps.
function uploadSourceMaps() {
  if (!process.env.SENTRY_AUTH_TOKEN) {
    console.log("SENTRY_AUTH_TOKEN is not set; skipping the Sentry source map upload.");
    return;
  }
  for (const name of ["SENTRY_ORG", "SENTRY_PROJECT"]) {
    if (!process.env[name]) throw new Error(`${name} is required when SENTRY_AUTH_TOKEN is set`);
  }
  const bundles = [join(desktop, "dist"), join(desktop, "dist-electron")];
  const cli = (...args) =>
    execFileSync("pnpm", ["exec", "sentry-cli", ...args], { stdio: "inherit" });
  cli("sourcemaps", "inject", ...bundles);
  cli("sourcemaps", "upload", "--release", `voice@${version}`, ...bundles);
}

try {
  execFileSync("pnpm", ["--dir", desktop, "run", "build"], { stdio: "inherit" });
  uploadSourceMaps();
  execFileSync("pnpm", ["build:helper"], { stdio: "inherit" });
  execFileSync(
    "pnpm",
    [
      "--dir",
      desktop,
      "exec",
      "electron-builder",
      "--mac",
      "--arm64",
      "--config",
      configFile,
      "--publish",
      "never",
    ],
    { stdio: "inherit" },
  );
  const app = join(desktop, "release", "mac-arm64", "Voice.app");
  if (!existsSync(app)) throw new Error("Packaged app is missing");
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], {
    stdio: "inherit",
  });
  await checkPackagedApp(app);
  execFileSync("xcrun", ["stapler", "validate", app], { stdio: "inherit" });
  const dmgs = readdirSync(join(desktop, "release")).filter((name) => name.endsWith(".dmg"));
  if (dmgs.length !== 1) throw new Error("Expected exactly one DMG");
  const { extractFile } = appBuilderRequire()("@electron/asar");
  const metadata = JSON.parse(
    extractFile(join(app, "Contents", "Resources", "app.asar"), "package.json").toString(),
  );
  if (
    metadata.version !== version ||
    metadata.voiceRelease?.channel !== channel ||
    metadata.voiceRelease?.updateUrl !== baseUrl
  ) {
    throw new Error("Packaged release metadata does not match requested release");
  }
} finally {
  rmSync(configFile, { force: true });
}

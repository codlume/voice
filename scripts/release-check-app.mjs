import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_FUSES = {
  RunAsNode: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
};
export const HELPER_ENTITLEMENTS = ["com.apple.security.device.audio-input"];

export function appBuilderRequire() {
  const desktop = fileURLToPath(new URL("../apps/desktop/", import.meta.url));
  const builderRequire = createRequire(
    realpathSync(join(desktop, "node_modules", "electron-builder", "package.json")),
  );
  return createRequire(builderRequire.resolve("app-builder-lib/package.json"));
}

export function packagedAppProblems({ fuses, helperEntitlements }) {
  return [
    ...Object.entries(REQUIRED_FUSES)
      .filter(([name, expected]) => fuses[name] !== expected)
      .map(
        ([name, expected]) => `fuse ${name} is ${fuses[name] ?? "missing"}, expected ${expected}`,
      ),
    ...HELPER_ENTITLEMENTS.filter((key) => !helperEntitlements.includes(key)).map(
      (key) => `voice-helper lacks entitlement ${key}`,
    ),
    ...helperEntitlements
      .filter((key) => !HELPER_ENTITLEMENTS.includes(key))
      .map((key) => `voice-helper has unexpected entitlement ${key}`),
  ];
}

async function readFuses(app) {
  const require = appBuilderRequire();
  const { getCurrentFuseWire, FuseV1Options } = require("@electron/fuses");
  const { FuseState } = require("@electron/fuses/dist/constants");
  const wire = await getCurrentFuseWire(join(app, "Contents", "MacOS", "Voice"));
  // The wire also holds a `version` key and fuses newer than this @electron/fuses can name.
  return Object.fromEntries(
    Object.entries(wire)
      .filter(([index]) => FuseV1Options[index] !== undefined)
      .map(([index, state]) => [FuseV1Options[index], state === FuseState.ENABLE]),
  );
}

function readHelperEntitlements(app) {
  const helper = join(app, "Contents", "Resources", "bin", "voice-helper");
  const xml = execFileSync("codesign", ["-d", "--entitlements", "-", "--xml", helper], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (xml.length === 0) return [];
  const plist = JSON.parse(
    execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], { input: xml, encoding: "utf8" }),
  );
  return Object.keys(plist).filter((key) => plist[key] === true);
}

export async function checkPackagedApp(app) {
  const observed = { fuses: await readFuses(app), helperEntitlements: readHelperEntitlements(app) };
  const problems = packagedAppProblems(observed);
  if (problems.length > 0) {
    throw new Error(`Packaged app ${app} failed checks:\n${problems.join("\n")}`);
  }
  return observed;
}

if (import.meta.main) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/release-check-app.mjs <Voice.app>");
  console.log(JSON.stringify(await checkPackagedApp(resolve(process.argv[2]))));
}

import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The policy a release must meet. It is kept apart from electron-builder.yml so a config edit
// cannot silently move the bar.
export const REQUIRED_FUSES = {
  RunAsNode: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
};
export const HELPER_ENTITLEMENTS = ["com.apple.security.device.audio-input"];
export const RUNTIME_EXTERNALS = ["electron-updater", "node-llama-cpp"];

export function appBuilderRequire() {
  const desktop = fileURLToPath(new URL("../apps/desktop/", import.meta.url));
  const builderRequire = createRequire(
    realpathSync(join(desktop, "node_modules", "electron-builder", "package.json")),
  );
  return createRequire(builderRequire.resolve("app-builder-lib/package.json"));
}

export function packagedAppProblems({ fuses, helperEntitlements, signatures }) {
  const { app, helper } = signatures;
  return [
    ...(app.team ? [] : ["Voice.app has no team identifier"]),
    ...(helper.team === app.team
      ? []
      : [
          helper.team
            ? `voice-helper is signed by team ${helper.team}, Voice.app by ${app.team}`
            : "voice-helper is ad hoc or unsigned",
        ]),
    ...(helper.runtime ? [] : ["voice-helper lacks the hardened runtime"]),
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

const PACKAGE_ROOT = /^(.*\/)?node_modules\/(@[^/]+\/)?[^/@][^/]*\/package\.json$/;

export function asarProblems(files, readManifest) {
  const present = new Set(files);
  const locate = (name, fromDir) => {
    const segments = fromDir ? fromDir.split("/") : [];
    for (;;) {
      const dir = [...segments, "node_modules", name].join("/");
      if (present.has(`${dir}/package.json`)) return dir;
      if (segments.length === 0) return null;
      segments.pop();
    }
  };
  const needed = new Set();
  const visit = (name, fromDir) => {
    const dir = locate(name, fromDir);
    if (!dir || needed.has(dir)) return;
    needed.add(dir);
    const { dependencies, optionalDependencies } = readManifest(`${dir}/package.json`);
    for (const dep of Object.keys({ ...dependencies, ...optionalDependencies })) visit(dep, dir);
  };
  for (const name of RUNTIME_EXTERNALS) visit(name, "");
  const maps = files.filter((file) => file.endsWith(".map"));
  return [
    ...RUNTIME_EXTERNALS.filter((name) => !locate(name, "")).map(
      (name) => `app.asar lacks runtime external ${name}`,
    ),
    ...files
      .filter((file) => PACKAGE_ROOT.test(file))
      .map((file) => file.slice(0, -"/package.json".length))
      .filter((dir) => !needed.has(dir))
      .map((dir) => `app.asar ships ${dir}, which ${RUNTIME_EXTERNALS.join(" and ")} do not need`),
    ...(maps.length > 0 ? [`app.asar ships ${maps.length} source maps, such as ${maps[0]}`] : []),
  ];
}

function readAsarProblems(app) {
  const asar = appBuilderRequire()("@electron/asar");
  const archive = join(app, "Contents", "Resources", "app.asar");
  return asarProblems(
    asar.listPackage(archive).map((file) => file.replace(/^\//, "")),
    (file) => JSON.parse(asar.extractFile(archive, file).toString()),
  );
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

const helperPath = (app) => join(app, "Contents", "Resources", "bin", "voice-helper");

function readSignature(path) {
  const { stderr } = spawnSync("codesign", ["-dv", path], { encoding: "utf8" });
  return {
    team: /^TeamIdentifier=(\w+)$/m.exec(stderr)?.[1] ?? null,
    runtime: /^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*\bruntime\b/m.test(stderr),
  };
}

function readHelperEntitlements(app) {
  const helper = helperPath(app);
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
  const observed = {
    fuses: await readFuses(app),
    helperEntitlements: readHelperEntitlements(app),
    signatures: { app: readSignature(app), helper: readSignature(helperPath(app)) },
  };
  const problems = [...packagedAppProblems(observed), ...readAsarProblems(app)];
  if (problems.length > 0) {
    throw new Error(`Packaged app ${app} failed checks:\n${problems.join("\n")}`);
  }
  return observed;
}

if (import.meta.main) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/release-check-app.mjs <Voice.app>");
  console.log(JSON.stringify(await checkPackagedApp(resolve(process.argv[2]))));
}

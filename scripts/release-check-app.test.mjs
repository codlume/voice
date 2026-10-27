import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asarProblems,
  HELPER_ENTITLEMENTS,
  packagedAppProblems,
  REQUIRED_FUSES,
  RUNTIME_EXTERNALS,
} from "./release-check-app.mjs";

const compliant = {
  fuses: {
    ...REQUIRED_FUSES,
    EnableCookieEncryption: false,
    GrantFileProtocolExtraPrivileges: true,
  },
  helperEntitlements: [...HELPER_ENTITLEMENTS],
  signatures: {
    app: { team: "TEAM123456", runtime: true },
    helper: { team: "TEAM123456", runtime: true },
  },
};

test("a packaged app with the required fuses and helper entitlements passes", () => {
  assert.deepEqual(packagedAppProblems(compliant), []);
});

test("an enabled RunAsNode fuse is the only problem reported", () => {
  const problems = packagedAppProblems({
    ...compliant,
    fuses: { ...compliant.fuses, RunAsNode: true },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /RunAsNode/);
});

test("a fuse missing from the wire is a problem", () => {
  const { OnlyLoadAppFromAsar: _, ...fuses } = compliant.fuses;
  assert.deepEqual(packagedAppProblems({ ...compliant, fuses }), [
    "fuse OnlyLoadAppFromAsar is missing, expected true",
  ]);
});

test("a helper entitlement beyond audio input is a problem", () => {
  assert.deepEqual(
    packagedAppProblems({
      ...compliant,
      helperEntitlements: [...HELPER_ENTITLEMENTS, "com.apple.security.cs.allow-jit"],
    }),
    ["voice-helper has unexpected entitlement com.apple.security.cs.allow-jit"],
  );
});

test("a helper without the audio input entitlement is a problem", () => {
  assert.deepEqual(packagedAppProblems({ ...compliant, helperEntitlements: [] }), [
    "voice-helper lacks entitlement com.apple.security.device.audio-input",
  ]);
});

test("an ad hoc helper inside a Developer ID app is a problem", () => {
  assert.deepEqual(
    packagedAppProblems({
      ...compliant,
      signatures: { ...compliant.signatures, helper: { team: null, runtime: false } },
    }),
    ["voice-helper is ad hoc or unsigned", "voice-helper lacks the hardened runtime"],
  );
});

test("an app without a Developer ID team is a problem", () => {
  const unsigned = { team: null, runtime: false };
  assert.deepEqual(
    packagedAppProblems({ ...compliant, signatures: { app: unsigned, helper: unsigned } }),
    ["Voice.app has no team identifier", "voice-helper lacks the hardened runtime"],
  );
});

function leanAsar() {
  const manifests = {
    "node_modules/electron-updater/package.json": {
      dependencies: { "fs-extra": "10", semver: "7" },
    },
    "node_modules/fs-extra/package.json": { dependencies: { "graceful-fs": "4" } },
    "node_modules/graceful-fs/package.json": {},
    "node_modules/semver/package.json": {},
    "node_modules/node-llama-cpp/package.json": {
      dependencies: { "fs-extra": "11" },
      optionalDependencies: {
        "@node-llama-cpp/mac-arm64-metal": "3",
        "@node-llama-cpp/win-x64": "3",
      },
    },
    "node_modules/node-llama-cpp/node_modules/fs-extra/package.json": {
      dependencies: { "graceful-fs": "4" },
    },
    "node_modules/@node-llama-cpp/mac-arm64-metal/package.json": {},
  };
  const files = [
    "package.json",
    "dist-electron/main.cjs",
    "dist/renderer/hub.html",
    ...Object.keys(manifests),
    "node_modules/semver/bin/semver.js",
    "node_modules/semver/internal/package.json",
  ];
  return { files, readManifest: (file) => manifests[file] };
}

test("an asar holding only the runtime externals and their dependency closure passes", () => {
  const { files, readManifest } = leanAsar();
  assert.deepEqual(asarProblems(files, readManifest), []);
});

test("a package outside the runtime closure is a problem, named by its path", () => {
  const { files, readManifest } = leanAsar();
  assert.deepEqual(
    asarProblems(
      [...files, "node_modules/effect/package.json", "node_modules/effect/index.js"],
      (file) => (file === "node_modules/effect/package.json" ? {} : readManifest(file)),
    ),
    [`app.asar ships node_modules/effect, which ${RUNTIME_EXTERNALS.join(" and ")} do not need`],
  );
});

test("a source map anywhere in the asar is a problem", () => {
  const { files, readManifest } = leanAsar();
  assert.deepEqual(
    asarProblems(
      [...files, "dist-electron/main.cjs.map", "dist/renderer/hub.js.map"],
      readManifest,
    ),
    ["app.asar ships 2 source maps, such as dist-electron/main.cjs.map"],
  );
});

test("a missing runtime external is a problem", () => {
  const { files, readManifest } = leanAsar();
  assert.deepEqual(
    asarProblems(
      files.filter((file) => !file.includes("node-llama-cpp/")),
      readManifest,
    ),
    ["app.asar lacks runtime external node-llama-cpp"],
  );
});

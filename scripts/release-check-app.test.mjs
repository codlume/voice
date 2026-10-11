import assert from "node:assert/strict";
import { test } from "node:test";
import { HELPER_ENTITLEMENTS, REQUIRED_FUSES, packagedAppProblems } from "./release-check-app.mjs";

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

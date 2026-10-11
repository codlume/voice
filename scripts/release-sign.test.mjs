import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import sign from "../apps/desktop/build/sign.mjs";
import { appBuilderRequire } from "./release-check-app.mjs";

const macCodeSign = appBuilderRequire()("app-builder-lib/out/codeSign/macCodeSign");

test("mac sign hook gives only the helper its own entitlements and keeps electron-builder's identity", async (t) => {
  const builderSign = macCodeSign.sign;
  let received;
  macCodeSign.sign = async (options) => {
    received = options;
  };
  t.after(() => {
    macCodeSign.sign = builderSign;
  });
  const app = "/tmp/release/mac-arm64/Voice.app";
  const helper = `${app}/Contents/Resources/bin/voice-helper`;
  const framework = `${app}/Contents/Frameworks/Electron Framework.framework`;
  const builderOptions = (file) => ({
    entitlements: file === app ? "/build/entitlements.mac.plist" : "/build/inherit.plist",
    hardenedRuntime: true,
    timestamp: undefined,
    requirements: undefined,
    additionalArguments: [],
  });
  await sign({
    app,
    identity: "0123456789ABCDEF0123456789ABCDEF01234567",
    keychain: "/tmp/voice-release.keychain-db",
    optionsForFile: builderOptions,
  });
  assert.equal(received.identity, "0123456789ABCDEF0123456789ABCDEF01234567");
  assert.equal(received.keychain, "/tmp/voice-release.keychain-db");
  assert.equal(received.app, app);
  assert.deepEqual(received.optionsForFile(helper), {
    ...builderOptions(helper),
    entitlements: fileURLToPath(
      new URL("../apps/desktop/build/entitlements.helper.plist", import.meta.url),
    ),
  });
  assert.ok(existsSync(received.optionsForFile(helper).entitlements));
  assert.deepEqual(received.optionsForFile(app), builderOptions(app));
  assert.deepEqual(received.optionsForFile(framework), builderOptions(framework));
});

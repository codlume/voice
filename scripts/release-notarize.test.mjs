import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import notarize, { STAPLE_DELAYS_MS, stapleWithRetry } from "../apps/desktop/build/notarize.mjs";
import { appBuilderRequire } from "./release-check-app.mjs";

const app = "/tmp/release/mac-arm64/Voice.app";
const desktop = fileURLToPath(new URL("../apps/desktop/", import.meta.url));

function flakyStapler(failures) {
  const calls = [];
  return {
    calls,
    run(path) {
      calls.push(path);
      if (calls.length <= failures) throw new Error(`stapler error 68 (${calls.length})`);
      return "stapled";
    },
  };
}

test("stapler retries a dropped connection with backoff and then succeeds", async () => {
  const stapler = flakyStapler(2);
  const waits = [];
  const result = await stapleWithRetry(app, {
    run: stapler.run,
    wait: async (ms) => waits.push(ms),
  });
  assert.equal(result, "stapled");
  assert.deepEqual(stapler.calls, [app, app, app]);
  assert.deepEqual(waits, STAPLE_DELAYS_MS.slice(0, 2));
});

test("stapler gives up after every retry and reports the last failure", async () => {
  const stapler = flakyStapler(Infinity);
  const waits = [];
  await assert.rejects(
    stapleWithRetry(app, { run: stapler.run, wait: async (ms) => waits.push(ms) }),
    /stapler error 68 \(5\)/,
  );
  assert.equal(stapler.calls.length, STAPLE_DELAYS_MS.length + 1);
  assert.deepEqual(waits, STAPLE_DELAYS_MS);
});

test("release config's afterSign path resolves to the notarize hook", async (t) => {
  const { resolveFunction } = appBuilderRequire()("app-builder-lib/out/util/resolve");
  const cwd = process.cwd();
  process.chdir(desktop);
  t.after(() => process.chdir(cwd));
  assert.equal(
    await resolveFunction("module", "./build/notarize.mjs", "afterSign", desktop),
    notarize,
  );
});

test("hook notarizes the packaged app, then staples it", async (t) => {
  const notarytool = appBuilderRequire()("@electron/notarize/lib/notarytool");
  const original = notarytool.notarizeAndWaitForNotaryTool;
  const steps = [];
  notarytool.notarizeAndWaitForNotaryTool = async (options) => steps.push(["notarize", options]);
  const env = { ...process.env };
  Object.assign(process.env, {
    APPLE_ID: "dev@example.com",
    APPLE_APP_SPECIFIC_PASSWORD: "app-password",
    APPLE_TEAM_ID: "TEAM123456",
  });
  t.after(() => {
    notarytool.notarizeAndWaitForNotaryTool = original;
    process.env = env;
  });
  await notarize(
    { appOutDir: "/tmp/release/mac-arm64", packager: { appInfo: { productFilename: "Voice" } } },
    { stapleApp: async (path) => steps.push(["staple", path]) },
  );
  assert.deepEqual(steps, [
    [
      "notarize",
      {
        appPath: app,
        appleId: "dev@example.com",
        appleIdPassword: "app-password",
        teamId: "TEAM123456",
      },
    ],
    ["staple", app],
  ]);
});

test("hook does not staple when notarization fails", async (t) => {
  const notarytool = appBuilderRequire()("@electron/notarize/lib/notarytool");
  const original = notarytool.notarizeAndWaitForNotaryTool;
  notarytool.notarizeAndWaitForNotaryTool = async () => {
    throw new Error("Failed to notarize via notarytool: Invalid");
  };
  const env = { ...process.env };
  Object.assign(process.env, {
    APPLE_ID: "a",
    APPLE_APP_SPECIFIC_PASSWORD: "b",
    APPLE_TEAM_ID: "c",
  });
  t.after(() => {
    notarytool.notarizeAndWaitForNotaryTool = original;
    process.env = env;
  });
  let stapled = false;
  await assert.rejects(
    notarize(
      { appOutDir: "/tmp/release/mac-arm64", packager: { appInfo: { productFilename: "Voice" } } },
      { stapleApp: async () => (stapled = true) },
    ),
    /Invalid/,
  );
  assert.equal(stapled, false);
});

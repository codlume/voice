import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { appBuilderRequire } from "../../../scripts/release-check-app.mjs";

// @electron/notarize gives stapler about 7 seconds of retries. A dropped CloudKit connection on the
// runner outlasts that, and failing the staple throws away a build Apple already notarized.
export const STAPLE_DELAYS_MS = [15_000, 30_000, 60_000, 120_000];

const staple = (app) =>
  execFileSync("xcrun", ["stapler", "staple", "-v", app], { stdio: "inherit" });

export async function stapleWithRetry(
  app,
  { run = staple, delays = STAPLE_DELAYS_MS, wait = sleep } = {},
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return run(app);
    } catch (error) {
      if (attempt >= delays.length) throw error;
      console.warn(
        `stapler failed; retry ${attempt + 1} of ${delays.length} in ${delays[attempt] / 1000}s`,
      );
      await wait(delays[attempt]);
    }
  }
}

// electron-builder's afterSign hook. It runs before the DMG and zip are built, so both carry the
// stapled app.
export default async function notarize(
  { appOutDir, packager },
  { stapleApp = stapleWithRetry } = {},
) {
  const {
    APPLE_ID: appleId,
    APPLE_APP_SPECIFIC_PASSWORD: appleIdPassword,
    APPLE_TEAM_ID: teamId,
  } = process.env;
  if (!appleId || !appleIdPassword || !teamId) {
    throw new Error("APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID are required");
  }
  const app = join(appOutDir, `${packager.appInfo.productFilename}.app`);
  const notarytool = appBuilderRequire()("@electron/notarize/lib/notarytool");
  await notarytool.notarizeAndWaitForNotaryTool({ appPath: app, appleId, appleIdPassword, teamId });
  await stapleApp(app);
}

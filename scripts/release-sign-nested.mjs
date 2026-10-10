import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// electron-builder signs every other binary in the bundle itself. mac.signIgnore keeps its pass
// off the helper, which needs its own entitlements.
export default async function signHelper(context) {
  if (!process.env.CI) return;
  const identity = process.env.APPLE_SIGN_IDENTITY;
  if (!identity) throw new Error("APPLE_SIGN_IDENTITY is required in CI");
  const helper = join(context.appOutDir, "Voice.app/Contents/Resources/bin/voice-helper");
  if (!existsSync(helper)) throw new Error("Packaged Swift helper is missing");
  execFileSync(
    "codesign",
    [
      "--force",
      "--sign",
      identity,
      "--options",
      "runtime",
      "--timestamp",
      "--entitlements",
      join(process.cwd(), "build/entitlements.helper.plist"),
      helper,
    ],
    { stdio: "inherit" },
  );
}

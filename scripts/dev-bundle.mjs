import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { VOICE_URL_SCHEME } from "../apps/desktop/src/shared/api.ts";

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

// macOS routes a URL scheme only to an app bundle that declares it, and the stock Electron.app
// declares none under a bundle id every worktree shares. A clone with Voice's scheme and its own id
// receives the sign-in link the way the packaged Voice.app does. Cloning on APFS costs no disk.
export function devBundleElectron(electronPath, devDir) {
  const contents = electronPath.lastIndexOf(".app/") + ".app".length;
  const source = electronPath.slice(0, contents);
  const bundle = join(devDir, "Voice Dev.app");
  const stampFile = join(devDir, "bundle.json");
  const info = {
    CFBundleIdentifier: "com.codlume.voice.dev",
    CFBundleName: "Voice Dev",
    CFBundleDisplayName: "Voice Dev",
    CFBundleURLTypes: [{ CFBundleURLName: "Voice Dev", CFBundleURLSchemes: [VOICE_URL_SCHEME] }],
  };
  const electronVersion = execFileSync(
    "plutil",
    ["-extract", "CFBundleVersion", "raw", join(source, "Contents/Info.plist")],
    { encoding: "utf8" },
  ).trim();
  const stamp = JSON.stringify({ electronVersion, info });

  if (!existsSync(bundle) || !existsSync(stampFile) || readFileSync(stampFile, "utf8") !== stamp) {
    const staging = join(devDir, "staging");
    const staged = join(staging, "Voice Dev.app");
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    execFileSync("cp", ["-cR", source, staged]);
    for (const [key, value] of Object.entries(info)) {
      execFileSync("plutil", [
        "-replace",
        key,
        "-json",
        JSON.stringify(value),
        join(staged, "Contents/Info.plist"),
      ]);
    }
    // Editing Info.plist breaks Electron's signature, and macOS refuses to run a broken one.
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", staged]);
    rmSync(bundle, { recursive: true, force: true });
    renameSync(staged, bundle);
    rmSync(staging, { recursive: true, force: true });
    writeFileSync(stampFile, stamp);
  }
  execFileSync(LSREGISTER, ["-f", bundle]);
  return join(bundle, electronPath.slice(contents));
}

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { VOICE_URL_SCHEME } from "../apps/desktop/src/shared/api.ts";

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

// The sign-in link still works by paste, so a bundle that cannot be built never blocks pnpm dev.
export function devElectronPath(stockElectronPath, devDir) {
  if (process.platform !== "darwin") return stockElectronPath;
  try {
    return devBundleElectron(stockElectronPath, devDir);
  } catch (error) {
    const reason = String(error instanceof Error ? error.message : error).split("\n")[0];
    console.error(
      `Voice Dev bundle unavailable: ${reason}; using stock Electron, so paste the sign-in code`,
    );
    return stockElectronPath;
  }
}

// macOS routes a URL scheme only to an app bundle that declares it, and the stock Electron.app
// declares none. This clone declares Voice's scheme. Every worktree's clone shares one bundle id,
// so the last-launched worktree receives the link.
function devBundleElectron(electronPath, devDir) {
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

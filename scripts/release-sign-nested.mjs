import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(root) {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    if (statSync(path).isDirectory()) return walk(path);
    return [path];
  });
}

export default async function signNested(context) {
  if (!process.env.CI) return;
  const identity = process.env.APPLE_SIGN_IDENTITY;
  if (!identity) throw new Error("APPLE_SIGN_IDENTITY is required in CI");
  const app = join(context.appOutDir, "Voice.app");
  const nested = walk(join(app, "Contents", "Resources")).filter(
    (path) =>
      path.endsWith("/voice-helper") ||
      /\.(node|dylib)$/.test(path) ||
      execFileSync("file", ["-b", path], { encoding: "utf8" }).includes("Mach-O"),
  );
  if (!nested.some((path) => path.endsWith("/voice-helper")))
    throw new Error("Packaged Swift helper is missing");
  for (const path of nested) {
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
        join(process.cwd(), "build/entitlements.mac.plist"),
        path,
      ],
      { stdio: "inherit" },
    );
  }
}

import { fileURLToPath } from "node:url";
import { appBuilderRequire } from "../../../scripts/release-check-app.mjs";

const HELPER = "/Contents/Resources/bin/voice-helper";
const helperEntitlements = fileURLToPath(new URL("./entitlements.helper.plist", import.meta.url));

// electron-builder signs nested binaries with entitlementsInherit, which would hand the helper
// Electron's JIT entitlements.
export default function sign(options) {
  const { optionsForFile } = options;
  const macCodeSign = appBuilderRequire()("app-builder-lib/out/codeSign/macCodeSign");
  return macCodeSign.sign({
    ...options,
    optionsForFile: (file) =>
      file.endsWith(HELPER)
        ? { ...optionsForFile(file), entitlements: helperEntitlements }
        : optionsForFile(file),
  });
}

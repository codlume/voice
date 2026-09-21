import { packager } from "@electron/packager";
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("Packaging requires Apple Silicon macOS");
const paths = await packager({
  dir: "apps/desktop/dist",
  out: "out",
  name: "Voice Development",
  executableName: "Voice Development",
  appBundleId: "com.codlume.voice.development",
  appVersion: "0.0.0",
  platform: "darwin",
  arch: "arm64",
  electronVersion: "44.1.0",
  asar: { unpack: "**/native/voice-helper" },
  extendInfo: {
    NSMicrophoneUsageDescription:
      "Voice uses the microphone only when you explicitly start dictation.",
  },
  overwrite: true,
  prune: false,
});
console.log(paths.join("\n"));

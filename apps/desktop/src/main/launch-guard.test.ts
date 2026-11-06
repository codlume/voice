import { describe, expect, test } from "vite-plus/test";

import { packagedHelperEnv, refusedLaunchArguments } from "./launch-guard.ts";

const SMOKE_ARGUMENTS = [
  "--user-data-dir=/tmp/voice-release-smoke-abc",
  "-ApplePersistenceIgnoreState",
  "YES",
];

describe("refusedLaunchArguments", () => {
  test.each([
    "--remote-debugging-port=0",
    "--remote-debugging-pipe",
    "--gpu-launcher=/usr/bin/true",
    "--renderer-cmd-prefix=/usr/bin/true",
    "--utility-cmd-prefix=/usr/bin/true",
    "--browser-subprocess-path=/usr/bin/true",
    "-remote-debugging-port=0",
    "--inspect=0",
    "--js-flags=x",
    "--no-sandbox",
    "--load-extension=/x",
    "--proxy-server=x",
    "--host-resolver-rules=x",
    "--disable-web-security",
    "--user-data-dir",
    "--user-data-dir=",
    "--",
  ])("refuses %s", (argument) => {
    expect(refusedLaunchArguments([argument])).toEqual([argument]);
  });

  test("refuses a hostile switch placed after the allowed smoke arguments", () => {
    expect(refusedLaunchArguments([...SMOKE_ARGUMENTS, "--remote-debugging-port=0"])).toEqual([
      "--remote-debugging-port=0",
    ]);
  });

  test("names every refused argument", () => {
    expect(
      refusedLaunchArguments(["--gpu-launcher=/x", "--user-data-dir=/tmp/ud", "--no-sandbox"]),
    ).toEqual(["--gpu-launcher=/x", "--no-sandbox"]);
  });

  test.each([
    ["the release smoke arguments", SMOKE_ARGUMENTS],
    ["no arguments", []],
    ["a LaunchServices process serial number", ["-psn_0_12345"]],
    ["a sign-in callback URL", ["com.codlume.voice://auth/callback?code=x"]],
  ])("allows %s", (_name, args) => {
    expect(refusedLaunchArguments(args)).toEqual([]);
  });
});

describe("packagedHelperEnv", () => {
  const kept = {
    HOME: "/Users/synthetic",
    PATH: "/usr/bin:/bin",
    USER: "synthetic",
    LOGNAME: "synthetic",
    SHELL: "/bin/zsh",
    TMPDIR: "/var/folders/synthetic/T/",
    LANG: "en_US.UTF-8",
    TZ: "Europe/Warsaw",
    LC_ALL: "en_US.UTF-8",
    LC_CTYPE: "UTF-8",
    __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
    http_proxy: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
  };
  const dropped = {
    VOICE_HELPER_PATH: "/tmp/evil-helper",
    VOICE_HELPER_TEST: "1",
    REGISTRY_URL: "http://127.0.0.1:9",
    MODEL_REGISTRY_URL: "http://127.0.0.1:9",
    HF_TOKEN: "synthetic-token",
    HUGGING_FACE_HUB_TOKEN: "synthetic-token",
    HUGGINGFACEHUB_API_TOKEN: "synthetic-token",
    CI: "1",
    DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
    NODE_OPTIONS: "--require /tmp/evil.js",
    ELECTRON_RUN_AS_NODE: "1",
  };

  test("passes only the allowed names, with their values unchanged", () => {
    expect(packagedHelperEnv({ ...dropped, ...kept })).toEqual(kept);
  });

  test("an allowed name is passed only when it is set", () => {
    expect(packagedHelperEnv({ HOME: "/Users/synthetic" })).toEqual({ HOME: "/Users/synthetic" });
  });
});

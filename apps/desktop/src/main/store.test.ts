import { describe, expect, test } from "vite-plus/test";

import { DEFAULT_SETTINGS } from "../shared/api.ts";
import { idle } from "./session.ts";
import { toSnapshot, type AppState } from "./store.ts";
import type { TransformRun } from "./transform-run.ts";

const state: AppState = {
  session: idle,
  transform: { phase: "reading", id: "r1", transformId: "polish" } as TransformRun,
  permissions: { microphone: "granted", accessibility: "granted" },
  loginItem: "off",
  models: { asr: { state: "ready" }, cleanup: { state: "ready" }, transform: { state: "missing" } },
  settings: DEFAULT_SETTINGS,
  updates: {
    version: "0.0.1",
    installedChannel: "stable",
    channel: "stable",
    status: { kind: "disabled", reason: "Test" },
  },
  microphones: { kind: "loading" },
  microphoneTest: { kind: "off" },
  account: { kind: "signedOut" },
};

describe("toSnapshot", () => {
  test("never carries the transform run to a window", () => {
    const snapshot = toSnapshot(state);
    expect(snapshot).not.toHaveProperty("transform");
    expect(Object.keys(snapshot).toSorted()).toEqual([
      "account",
      "loginItem",
      "microphoneTest",
      "microphones",
      "models",
      "permissions",
      "session",
      "settings",
      "updates",
    ]);
    expect(snapshot.session).toEqual({ kind: "idle" });
  });
});

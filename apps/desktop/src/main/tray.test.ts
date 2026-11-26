import { describe, expect, test, vi } from "vite-plus/test";

import type { Permissions } from "../shared/api.ts";
import { trayStatus, trayStatusItems } from "./tray.ts";

const granted: Permissions = {
  microphone: "granted",
  accessibility: "granted",
  systemAudio: "notDetermined",
};

const labels = (permissions: Permissions) =>
  trayStatusItems(trayStatus(permissions), () => {}).map((item) => item.label ?? item.type);

describe("tray status", () => {
  test("says nothing while dictation has what it needs, whatever meetings lack", () => {
    expect(trayStatus(granted)).toEqual({ kind: "ok" });
    expect(labels({ ...granted, systemAudio: "denied" })).toEqual([]);
  });

  test("offers to allow each missing dictation permission, the shortcut first", () => {
    expect(labels({ ...granted, accessibility: "denied" })).toEqual([
      "Shortcut off: allow Accessibility…",
      "separator",
    ]);
    expect(labels({ ...granted, microphone: "notDetermined" })).toEqual([
      "Microphone off: allow access…",
      "separator",
    ]);
    expect(labels({ ...granted, microphone: "denied", accessibility: "notDetermined" })).toEqual([
      "Shortcut off: allow Accessibility…",
      "Microphone off: allow access…",
      "separator",
    ]);
  });

  test("an Allow item asks for its own permission", () => {
    const allow = vi.fn();
    const items = trayStatusItems(
      trayStatus({ ...granted, microphone: "denied", accessibility: "denied" }),
      allow,
    );
    for (const item of items) item.click?.(undefined as never, undefined, undefined as never);
    expect(allow.mock.calls).toEqual([["accessibility"], ["microphone"]]);
  });
});

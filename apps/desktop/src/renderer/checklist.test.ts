import { describe, expect, test } from "vite-plus/test";

import type { ModelStatus, Snapshot } from "../shared/api.ts";
import { DEFAULT_TRANSFORMS } from "../shared/transforms.ts";
import { dictationLanguages } from "../shared/dictation-language.ts";
import { DEFAULT_STYLES } from "../shared/style.ts";
import { checklist } from "./checklist.ts";

const fresh: Snapshot = {
  updates: {
    version: "0.0.1",
    installedChannel: "stable",
    channel: "stable",
    status: { kind: "disabled", reason: "Test" },
  },
  session: { kind: "idle" },
  permissions: {
    microphone: "notDetermined",
    accessibility: "notDetermined",
    systemAudio: "notDetermined",
  },
  loginItem: "off",
  models: {
    asr: { state: "missing" },
    cleanup: { state: "missing" },
    transform: { state: "missing" },
  },
  settings: {
    hotkey: "fn",
    toggleHotkey: null,
    updateChannel: "stable",
    theme: "system",
    pageAnimationMs: 200,
    microphone: null,
    lowerAudioWhileDictating: false,
    lowerAudioByPercent: 70,
    copyToClipboard: false,
    showInDock: true,
    alwaysShowPill: true,
    dictationLanguage: "en",
    cleanup: { enabled: true, styles: DEFAULT_STYLES, assignments: [] },
    diagnostics: "off",
    snippets: [],
    dictionary: [],
    zoomLevel: 0,
    transforms: DEFAULT_TRANSFORMS,
  },
  microphones: {
    kind: "ready",
    devices: [
      { uid: "builtin", name: "MacBook Pro Microphone" },
      { uid: "usb", name: "USB Microphone" },
    ],
    defaultUid: "builtin",
  },
  microphoneTest: { kind: "off" },
  account: { kind: "signedOut" },
};

const allReady: Snapshot = {
  ...fresh,
  permissions: { microphone: "granted", accessibility: "granted", systemAudio: "notDetermined" },
  models: { asr: { state: "ready" }, cleanup: { state: "ready" }, transform: { state: "missing" } },
};

const row = (snapshot: Snapshot, id: string) => {
  const found = checklist(snapshot).rows.find((r) => r.id === id);
  if (!found) throw new Error(`no ${id} row`);
  return found;
};

const withAsr = (asr: ModelStatus): Snapshot => ({ ...fresh, models: { ...fresh.models, asr } });
const withCleanup = (cleanup: ModelStatus): Snapshot => ({
  ...fresh,
  models: { ...fresh.models, cleanup },
});

describe("checklist", () => {
  test("a fresh install lists all four steps, each with its actions", () => {
    const list = checklist(fresh);
    expect(list.ready).toBe(false);
    expect(list.rows.map((r) => [r.title, r.status.text, r.actions.map((a) => a.label)])).toEqual([
      ["Microphone", "Needs access", ["Grant"]],
      ["Accessibility", "Needs access", ["Grant"]],
      ["Speech model", "Not downloaded", ["Download"]],
      ["Cleanup model", "Not downloaded", ["Download"]],
    ]);
    expect(row(fresh, "asr").subtitle).toBe("Parakeet by NVIDIA");
    expect(row(fresh, "cleanup").subtitle).toBe("S1-mini by Superwhisper");
  });

  test("actions carry the command the row needs", () => {
    expect(row(fresh, "accessibility").actions[0]?.command).toEqual({
      type: "requestPermission",
      kind: "accessibility",
    });
    expect(row(fresh, "asr").actions[0]?.command).toEqual({ type: "installModel", id: "asr" });
    expect(row(fresh, "cleanup").actions[0]?.command).toEqual({
      type: "installModel",
      id: "cleanup",
    });
    const failed = row(withAsr({ state: "failed", message: "offline" }), "asr");
    expect(failed.actions[0]?.command).toEqual({ type: "installModel", id: "asr" });
  });

  test("a downloaded model that is not loaded counts as ready", () => {
    const snapshot: Snapshot = {
      ...allReady,
      models: { ...allReady.models, cleanup: { state: "installed" } },
    };
    expect(row(snapshot, "cleanup").status).toEqual({ kind: "ready", text: "Downloaded" });
    expect(row(snapshot, "cleanup").actions).toEqual([]);
    expect(checklist(snapshot).ready).toBe(true);
  });

  test("a denied permission sends the user to System Settings", () => {
    const denied: Snapshot = {
      ...fresh,
      permissions: { ...fresh.permissions, microphone: "denied" },
    };
    expect(row(denied, "microphone").actions).toEqual([
      { label: "Open", command: { type: "requestPermission", kind: "microphone" } },
    ]);
  });

  test("a speech model download shows progress and offers no action", () => {
    const r = row(withAsr({ state: "downloading", progress: 0.42 }), "asr");
    expect(r.status).toEqual({ kind: "busy", text: "Downloading 42%", progress: 0.42 });
    expect(r.actions).toEqual([]);
    expect(row(withAsr({ state: "downloading" }), "asr").status).toEqual({
      kind: "busy",
      text: "Downloading",
    });
    expect(row(withAsr({ state: "loading" }), "asr").actions).toEqual([]);
  });

  test("a cleanup model download offers Cancel, which uninstalls it", () => {
    const cancel = { label: "Cancel", command: { type: "uninstallModel", id: "cleanup" } };
    const r = row(withCleanup({ state: "downloading", progress: 0.42 }), "cleanup");
    expect(r.status).toEqual({ kind: "busy", text: "Downloading 42%", progress: 0.42 });
    expect(r.actions).toEqual([cancel]);
    expect(row(withCleanup({ state: "downloading" }), "cleanup").actions).toEqual([cancel]);
    expect(row(withCleanup({ state: "loading" }), "cleanup").actions).toEqual([]);
  });

  test("a failed model shows its message and offers Retry", () => {
    const r = row(withAsr({ state: "failed", message: "Network unreachable" }), "asr");
    expect(r.status).toEqual({ kind: "failed", text: "Network unreachable" });
    expect(r.actions.map((a) => a.label)).toEqual(["Retry"]);
  });

  test("ready only when every step is ready", () => {
    expect(checklist(allReady).ready).toBe(true);
    const loading: Snapshot = {
      ...allReady,
      models: { ...allReady.models, cleanup: { state: "loading" } },
    };
    expect(checklist(loading).ready).toBe(false);
    const denied: Snapshot = {
      ...allReady,
      permissions: { ...allReady.permissions, accessibility: "denied" },
    };
    expect(checklist(denied).ready).toBe(false);
  });

  test.each(dictationLanguages.filter(({ value }) => value !== "en"))(
    "$label does not require the English cleanup model",
    ({ value }) => {
      const snapshot: Snapshot = {
        ...allReady,
        models: { ...allReady.models, cleanup: { state: "missing" } },
        settings: { ...allReady.settings, dictationLanguage: value },
      };
      expect(checklist(snapshot).ready).toBe(true);
      expect(checklist(snapshot).rows.map((r) => r.id)).not.toContain("cleanup");
    },
  );

  test("the transform model joins the checklist only while Transforms are on", () => {
    expect(checklist(allReady).rows.map((r) => r.id)).not.toContain("transform");
    const on: Snapshot = {
      ...allReady,
      settings: { ...allReady.settings, transforms: { ...DEFAULT_TRANSFORMS, enabled: true } },
    };
    const list = checklist(on);
    expect(list.ready).toBe(false);
    expect(row(on, "transform")).toMatchObject({
      title: "Transform model",
      subtitle: "Gemma 4 E2B by Google",
      status: { kind: "needed", text: "Not downloaded" },
      actions: [{ label: "Download", command: { type: "installModel", id: "transform" } }],
    });
  });

  test("with cleanup off, the cleanup model neither shows nor blocks readiness", () => {
    const cleanupOff: Snapshot = {
      ...allReady,
      models: { ...allReady.models, cleanup: { state: "missing" } },
      settings: { ...allReady.settings, cleanup: { ...allReady.settings.cleanup, enabled: false } },
    };
    const list = checklist(cleanupOff);
    expect(list.ready).toBe(true);
    expect(list.rows.map((r) => r.id)).not.toContain("cleanup");
  });
});

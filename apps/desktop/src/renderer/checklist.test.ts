import { describe, expect, test } from "vite-plus/test";

import type { ModelStatus, Snapshot } from "../shared/api.ts";
import { DEFAULT_TRANSFORMS } from "../shared/transforms.ts";
import { dictationLanguages } from "../shared/dictation-language.ts";
import { DEFAULT_STYLES } from "../shared/style.ts";
import { checklist, meetingsChecklist, summaryModelRow } from "./checklist.ts";

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
  speakerModel: "ready",
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
    meetingShortcut: null,
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
  meetingNotices: [],
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
    expect(row(withAsr({ state: "loading" }), "asr").subtitle).toBe("Parakeet by NVIDIA");
    expect(row(withAsr({ state: "loading", preparing: true }), "asr")).toMatchObject({
      subtitle: "Preparing for this Mac, about 30 s",
      status: { kind: "busy", text: "Loading" },
    });
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

const rows = (
  permissions: Snapshot["permissions"],
  options = { tried: false, shortcut: "⌥M" as string | null },
  speakerModel: Snapshot["speakerModel"] = "ready",
) => meetingsChecklist({ permissions, speakerModel }, options);
const summary = (list: ReturnType<typeof meetingsChecklist>) =>
  list.rows.map((r) => [r.id, r.status.kind, r.status.text, r.actions.map((a) => a.label)]);

describe("meetingsChecklist", () => {
  test("a fresh Mac asks for both permissions, the speaker models and a first meeting", () => {
    const list = rows(fresh.permissions, undefined, "missing");
    expect(list.ready).toBe(false);
    expect(summary(list)).toEqual([
      ["microphone", "needed", "Needs access", ["Grant"]],
      ["systemAudio", "needed", "Needs access", ["Grant"]],
      ["speakerModel", "needed", "Not downloaded", ["Download"]],
      ["tryMeetings", "needed", "Not yet", []],
    ]);
    expect(list.rows[2]?.actions[0]?.command).toEqual({ type: "downloadSpeakerModel" });
    expect(list.rows[1]?.actions[0]?.command).toEqual({
      type: "requestPermission",
      kind: "systemAudio",
    });
    expect(list.rows[3]?.subtitle).toBe(
      "Click Start meeting or press ⌥M, talk a little, then stop",
    );
    expect(rows(fresh.permissions, { tried: false, shortcut: null }).rows[3]?.subtitle).toBe(
      "Click Start meeting, talk a little, then stop",
    );
  });

  test("a denied System Audio Recording sends the user to System Settings", () => {
    const list = rows({ ...fresh.permissions, microphone: "granted", systemAudio: "denied" });
    expect(summary(list).slice(0, 2)).toEqual([
      ["microphone", "ready", "Granted", []],
      ["systemAudio", "needed", "Allow Voice in System Settings", ["Open"]],
    ]);
  });

  test("below macOS 14.4 system audio is unavailable, says so, and does not hold it open", () => {
    const permissions = { ...fresh.permissions, microphone: "granted", systemAudio: "unavailable" };
    const list = rows(permissions as Snapshot["permissions"], { tried: true, shortcut: null });
    expect(list.rows[1]).toMatchObject({
      status: { kind: "unavailable", text: "Needs macOS 14.4 or later" },
      subtitle: "Meetings record only your microphone on this Mac",
      actions: [],
    });
    expect(list.ready).toBe(true);
  });

  test("it is done once both are granted and one meeting was tried", () => {
    const granted = {
      ...fresh.permissions,
      microphone: "granted",
      systemAudio: "granted",
    } as const;
    expect(rows(granted).ready).toBe(false);
    expect(rows(granted, { tried: true, shortcut: null }).ready).toBe(true);
  });
});

test("speaker detection downloads only when asked, can be retried, and is optional where it cannot run", () => {
  const granted = { ...fresh.permissions, microphone: "granted", systemAudio: "granted" } as const;
  const speaker = (state: Snapshot["speakerModel"]) =>
    summary(rows(granted, { tried: true, shortcut: null }, state))[2];
  expect(speaker("downloading")).toEqual(["speakerModel", "busy", "Downloading", []]);
  expect(speaker("failed")).toEqual(["speakerModel", "failed", "Download failed", ["Retry"]]);
  expect(speaker("ready")).toEqual(["speakerModel", "ready", "Downloaded", []]);
  expect(speaker("unavailable")).toEqual([
    "speakerModel",
    "unavailable",
    "Needs macOS 15 or later",
    [],
  ]);
  expect(rows(granted, { tried: true, shortcut: null }, "unavailable").ready).toBe(true);
  expect(rows(granted, { tried: true, shortcut: null }, "missing").ready).toBe(false);
});

const withTransform = (transform: ModelStatus) =>
  summaryModelRow({ models: { ...fresh.models, transform } });

describe("summaryModelRow", () => {
  test("offers the transform model while it is not on disk", () => {
    expect(withTransform({ state: "missing" })).toMatchObject({
      title: "Summary model",
      subtitle: "Summaries use Gemma 4 E2B by Google (3.1 GB). Transcripts work without it.",
      status: { kind: "needed", text: "Not downloaded" },
      actions: [{ label: "Download", command: { type: "installModel", id: "transform" } }],
    });
    expect(withTransform({ state: "downloading", progress: 0.5 })?.actions).toEqual([
      { label: "Cancel", command: { type: "uninstallModel", id: "transform" } },
    ]);
    expect(withTransform({ state: "failed", message: "Offline" })?.actions[0]?.label).toBe("Retry");
  });

  test.each<ModelStatus>([{ state: "installed" }, { state: "loading" }, { state: "ready" }])(
    "is gone once the model is on disk (%j)",
    (transform) => {
      expect(withTransform(transform)).toBeNull();
    },
  );
});

import { describe, expect, test } from "vite-plus/test";

import type { ModelStatus, Snapshot } from "../shared/api.ts";
import { checklist } from "./checklist.ts";

const fresh: Snapshot = {
  updates: {
    version: "0.0.1",
    installedChannel: "stable",
    channel: "stable",
    status: { kind: "disabled", reason: "Test" },
  },
  session: { kind: "idle" },
  permissions: { microphone: "notDetermined", accessibility: "notDetermined" },
  models: { asr: { state: "missing" }, cleanup: { state: "missing" } },
  settings: {
    hotkey: "fn",
    updateChannel: "stable",
    theme: "system",
    cleanup: { enabled: true, styling: "semi-formal" },
  },
  last: null,
};

const allReady: Snapshot = {
  ...fresh,
  permissions: { microphone: "granted", accessibility: "granted" },
  models: { asr: { state: "ready" }, cleanup: { state: "ready" } },
};

const row = (snapshot: Snapshot, id: string) => {
  const found = checklist(snapshot).rows.find((r) => r.id === id);
  if (!found) throw new Error(`no ${id} row`);
  return found;
};

const withAsr = (asr: ModelStatus): Snapshot => ({ ...fresh, models: { ...fresh.models, asr } });

describe("checklist", () => {
  test("a fresh install lists all four steps, each with its action", () => {
    const list = checklist(fresh);
    expect(list.ready).toBe(false);
    expect(list.rows.map((r) => [r.title, r.status.text, r.action?.label])).toEqual([
      ["Microphone", "Needs access", "Grant"],
      ["Accessibility", "Needs access", "Grant"],
      ["Speech model", "Not downloaded", "Download"],
      ["Cleanup model", "Not downloaded", "Download"],
    ]);
    expect(row(fresh, "cleanup").subtitle).toBe("S1-mini by Superwhisper");
  });

  test("actions carry the command the row needs", () => {
    expect(row(fresh, "accessibility").action?.command).toEqual({
      type: "requestPermission",
      kind: "accessibility",
    });
    expect(row(fresh, "asr").action?.command).toEqual({ type: "setupModels" });
  });

  test("a denied permission sends the user to System Settings", () => {
    const denied: Snapshot = {
      ...fresh,
      permissions: { ...fresh.permissions, microphone: "denied" },
    };
    expect(row(denied, "microphone").action).toEqual({
      label: "Open",
      command: { type: "requestPermission", kind: "microphone" },
    });
  });

  test("downloading shows progress and offers no action", () => {
    const r = row(withAsr({ state: "downloading", progress: 0.42 }), "asr");
    expect(r.status).toEqual({ kind: "busy", text: "Downloading 42%", progress: 0.42 });
    expect(r.action).toBeUndefined();
    expect(row(withAsr({ state: "downloading" }), "asr").status).toEqual({
      kind: "busy",
      text: "Downloading",
    });
    expect(row(withAsr({ state: "loading" }), "asr").action).toBeUndefined();
  });

  test("a failed model shows its message and offers Retry", () => {
    const r = row(withAsr({ state: "failed", message: "Network unreachable" }), "asr");
    expect(r.status).toEqual({ kind: "failed", text: "Network unreachable" });
    expect(r.action?.label).toBe("Retry");
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

import { describe, expect, test } from "vite-plus/test";

import { pendingUpdate, type PillState, type UpdateStatus } from "../shared/api.ts";
import { releaseCardTitle, updateButton, updateStatusText } from "./updateStatus.ts";

const idle: PillState = { kind: "idle" };

describe("update controls", () => {
  test("restart is offered only when an update is ready and dictation is inactive", () => {
    const ready: UpdateStatus = { kind: "ready", version: "1.5.0", notes: [] };
    const sessions: PillState[] = [
      idle,
      { kind: "listening" },
      { kind: "processing" },
      { kind: "done", outcome: { kind: "inserted", method: "accessibility" } },
    ];
    expect(sessions.map((session) => updateButton(ready, session))).toEqual([
      { action: "restart", label: "Restart to install 1.5.0", tooltip: "Restart to install 1.5.0" },
      {
        action: null,
        label: "Finish dictation before restarting",
        tooltip: "Finish dictation before restarting",
      },
      {
        action: null,
        label: "Finish dictation before restarting",
        tooltip: "Finish dictation before restarting",
      },
      { action: "restart", label: "Restart to install 1.5.0", tooltip: "Restart to install 1.5.0" },
    ]);
  });

  test("the button checks for updates only when no update work is in flight", () => {
    const statuses: UpdateStatus[] = [
      { kind: "idle" },
      { kind: "current" },
      { kind: "failed", message: "Connection timed out" },
      { kind: "checking" },
      { kind: "downloading", version: "1.5.0", notes: [], percent: 48.4 },
      { kind: "installing", version: "1.5.0" },
      { kind: "disabled", reason: "Only packaged builds update" },
    ];
    expect(statuses.map((status) => updateButton(status, idle))).toEqual([
      { action: "check", label: "Check for updates", tooltip: "Check for updates" },
      { action: "check", label: "Check for updates", tooltip: "Check for updates" },
      { action: "check", label: "Check for updates", tooltip: "Connection timed out" },
      { action: null, label: "Checking for updates…", tooltip: "Checking for updates…" },
      { action: null, label: "Downloading 1.5.0 · 48%", tooltip: "Downloading 1.5.0 · 48%" },
      { action: null, label: "Installing 1.5.0…", tooltip: "Installing 1.5.0…" },
      {
        action: null,
        label: "Only packaged builds update",
        tooltip: "Only packaged builds update",
      },
    ]);
  });

  test("status text keeps useful failure and disabled reasons visible", () => {
    expect(updateStatusText({ kind: "failed", message: "Connection timed out" })).toBe(
      "Connection timed out",
    );
    expect(updateStatusText({ kind: "disabled", reason: "Only packaged builds update" })).toBe(
      "Only packaged builds update",
    );
    expect(
      updateStatusText({ kind: "downloading", version: "1.5.0", notes: [], percent: 48.4 }),
    ).toBe("Downloading 1.5.0 · 48%");
  });

  test("only a downloading or ready update gets a release card", () => {
    const statuses: UpdateStatus[] = [
      { kind: "idle" },
      { kind: "checking" },
      { kind: "current" },
      { kind: "downloading", version: "1.5.0", notes: ["fix: one"], percent: 48.4 },
      { kind: "ready", version: "1.5.0", notes: ["fix: one"] },
      { kind: "installing", version: "1.5.0" },
      { kind: "failed", message: "Connection timed out" },
      { kind: "disabled", reason: "Only packaged builds update" },
    ];
    expect(
      statuses.map((status) => {
        const update = pendingUpdate(status);
        return update && releaseCardTitle(update);
      }),
    ).toEqual([
      null,
      null,
      null,
      "Downloading 1.5.0 · 48%",
      "Restart to install 1.5.0",
      null,
      null,
      null,
    ]);
  });
});

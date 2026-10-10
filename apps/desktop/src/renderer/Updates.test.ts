import { describe, expect, test } from "vite-plus/test";

import type { Outcome, PillState, UpdateStatus } from "../shared/api.ts";
import {
  releaseCardTitle,
  restartPrompt,
  updateButton,
  updateCard,
  updateStatusText,
  type RestartPrompt,
  type UpdateCard,
} from "./updateStatus.ts";

function cardText(card: UpdateCard | null) {
  if (card === null) return null;
  return card.kind === "release" ? releaseCardTitle(card.update) : `error: ${card.message}`;
}

function choices(prompt: RestartPrompt) {
  return prompt.actions.map(({ label, choice }) => `${label} -> ${choice}`);
}

const idle: PillState = { kind: "idle" };
const done = (outcome: Outcome): PillState => ({ kind: "done", outcome });

describe("update controls", () => {
  test("dictation blocks restart but not download", () => {
    const ready: UpdateStatus = { kind: "ready", version: "1.5.0", notes: [] };
    const available: UpdateStatus = { kind: "available", version: "1.5.0", notes: [] };
    const sessions: PillState[] = [
      idle,
      { kind: "listening" },
      { kind: "processing", overdue: false },
      { kind: "done", outcome: { kind: "inserted", method: "accessibility" } },
    ];
    expect(sessions.map((session) => updateButton(ready, session))).toEqual([
      { action: "restart", label: "Restart to install 1.5.0" },
      {
        action: null,
        label: "Finish dictation before restarting",
      },
      {
        action: null,
        label: "Finish dictation before restarting",
      },
      { action: "restart", label: "Restart to install 1.5.0" },
    ]);
    expect(updateButton(available, { kind: "listening" })).toEqual({
      action: "download",
      label: "Download 1.5.0",
    });
  });

  test("the button checks when idle, downloads an available update, and waits on work in flight", () => {
    const statuses: UpdateStatus[] = [
      { kind: "idle" },
      { kind: "current" },
      { kind: "failed", message: "Connection timed out" },
      { kind: "available", version: "1.5.0", notes: [] },
      { kind: "checking" },
      { kind: "downloading", version: "1.5.0", notes: [], percent: 48.4 },
      { kind: "installing", version: "1.5.0" },
      { kind: "disabled", reason: "Only packaged builds update" },
    ];
    expect(statuses.map((status) => updateButton(status, idle))).toEqual([
      { action: "check", label: "Check for updates" },
      { action: "check", label: "Check for updates" },
      { action: "check", label: "Check for updates" },
      { action: "download", label: "Download 1.5.0" },
      { action: null, label: "Checking for updates…" },
      { action: null, label: "Downloading 1.5.0 · 48%" },
      { action: null, label: "Installing 1.5.0…" },
      {
        action: null,
        label: "Only packaged builds update",
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
    expect(updateStatusText({ kind: "available", version: "1.5.0", notes: [] })).toBe(
      "Version 1.5.0 is available",
    );
    expect(
      updateStatusText({ kind: "downloading", version: "1.5.0", notes: [], percent: 48.4 }),
    ).toBe("Downloading 1.5.0 · 48%");
  });

  test("a pending update gets a release card and a failed one gets an error card", () => {
    const statuses: UpdateStatus[] = [
      { kind: "idle" },
      { kind: "checking" },
      { kind: "current" },
      { kind: "available", version: "1.5.0", notes: ["fix: one"] },
      { kind: "downloading", version: "1.5.0", notes: ["fix: one"], percent: 48.4 },
      { kind: "ready", version: "1.5.0", notes: ["fix: one"] },
      { kind: "installing", version: "1.5.0" },
      { kind: "failed", message: "Connection timed out" },
      { kind: "disabled", reason: "Only packaged builds update" },
    ];
    expect(statuses.map((status) => cardText(updateCard(status, "")))).toEqual([
      null,
      null,
      null,
      "Download 1.5.0",
      "Downloading 1.5.0 · 48%",
      "Restart to install 1.5.0",
      null,
      "error: Connection timed out",
      null,
    ]);
  });

  test("a rejected update action shows its error over the release it acted on", () => {
    const ready: UpdateStatus = { kind: "ready", version: "1.5.0", notes: [] };
    expect(cardText(updateCard(ready, "Voice could not restart."))).toBe(
      "error: Voice could not restart.",
    );
    expect(cardText(updateCard({ kind: "current" }, "Voice could not check."))).toBe(
      "error: Voice could not check.",
    );
  });

  test("a restart offers to save the last transcript and requires it when it was not inserted", () => {
    const last = { raw: "um ship it friday", text: "Ship it Friday." };
    const inserted = done({ kind: "inserted", method: "paste" });
    const notInserted = done({ kind: "notInserted", reason: "focusChanged" });

    const withoutTranscript = restartPrompt(null, notInserted);
    expect(choices(withoutTranscript)).toEqual(["Restart -> restart"]);
    expect(withoutTranscript.description).toBe(
      "Voice will close and reopen with the downloaded version.",
    );

    expect(choices(restartPrompt(last, notInserted))).toEqual([
      "Copy transcript and restart -> copyTranscriptAndRestart",
    ]);
    expect(choices(restartPrompt(last, done({ kind: "failed", message: "Paste failed" })))).toEqual(
      ["Copy transcript and restart -> copyTranscriptAndRestart"],
    );

    for (const session of [inserted, idle]) {
      const prompt = restartPrompt(last, session);
      expect(choices(prompt)).toEqual([
        "Restart -> restart",
        "Copy transcript and restart -> copyTranscriptAndRestart",
      ]);
      expect(prompt.description).toBe(
        "Your last transcript is kept only until Voice closes. Copy it to the clipboard before restarting. This replaces the current clipboard contents.",
      );
    }
  });
});

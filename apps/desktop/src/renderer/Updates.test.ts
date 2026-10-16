import { describe, expect, test } from "vite-plus/test";

import type { PillState, UpdateStatus } from "../shared/api.ts";
import type { HistoryEntry, HistoryState, HistoryStatus } from "../shared/history.ts";
import {
  releaseCardTitle,
  restartPrompt,
  samePrompt,
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
const noNotes = { releases: [], omitted: 0 };
const oneNote = { releases: [{ version: "1.5.0", items: ["fix: one"] }], omitted: 0 };
const latest = (status: HistoryStatus): HistoryEntry => ({
  id: "s1",
  at: 0,
  raw: "um ship it friday",
  text: "Ship it Friday.",
  status,
});
const history = (
  entry: HistoryEntry | null,
  retention: HistoryState["retention"],
  saveFailed = false,
): HistoryState => ({ entries: entry ? [entry] : [], retention, saveFailed });

describe("update controls", () => {
  test("dictation blocks restart but not download", () => {
    const ready: UpdateStatus = { kind: "ready", version: "1.5.0", notes: noNotes };
    const available: UpdateStatus = { kind: "available", version: "1.5.0", notes: noNotes };
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
      { kind: "available", version: "1.5.0", notes: noNotes },
      { kind: "checking" },
      { kind: "downloading", version: "1.5.0", notes: noNotes, percent: 48.4 },
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
    expect(updateStatusText({ kind: "available", version: "1.5.0", notes: noNotes })).toBe(
      "Version 1.5.0 is available",
    );
    expect(
      updateStatusText({ kind: "downloading", version: "1.5.0", notes: noNotes, percent: 48.4 }),
    ).toBe("Downloading 1.5.0 · 48%");
  });

  test("a pending update gets a release card and a failed one gets an error card", () => {
    const statuses: UpdateStatus[] = [
      { kind: "idle" },
      { kind: "checking" },
      { kind: "current" },
      { kind: "available", version: "1.5.0", notes: oneNote },
      { kind: "downloading", version: "1.5.0", notes: oneNote, percent: 48.4 },
      { kind: "ready", version: "1.5.0", notes: oneNote },
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
    const ready: UpdateStatus = { kind: "ready", version: "1.5.0", notes: noNotes };
    expect(cardText(updateCard(ready, "Voice could not restart."))).toBe(
      "error: Voice could not restart.",
    );
    expect(cardText(updateCard({ kind: "current" }, "Voice could not check."))).toBe(
      "error: Voice could not check.",
    );
  });

  test("a restart offers to save the last transcript and requires it when it was not inserted", () => {
    const withoutTranscript = restartPrompt(history(null, "memory"));
    expect(choices(withoutTranscript)).toEqual(["Restart -> restart"]);
    expect(withoutTranscript.description).toBe(
      "Voice will close and reopen with the downloaded version.",
    );

    for (const status of ["notInserted", "pending"] as const) {
      expect(choices(restartPrompt(history(latest(status), "memory")))).toEqual([
        "Copy transcript and restart -> copyTranscriptAndRestart",
      ]);
    }

    const prompt = restartPrompt(history(latest("inserted"), "memory"));
    expect(choices(prompt)).toEqual([
      "Restart -> restart",
      "Copy transcript and restart -> copyTranscriptAndRestart",
    ]);
    expect(prompt.description).toBe(
      "Your history is kept only until Voice closes. Copy your last transcript to the clipboard before restarting. This replaces the current clipboard contents.",
    );
  });

  test("a saved history needs no copy, even for a transcript that was not inserted", () => {
    for (const retention of ["day", "month", "forever"] as const) {
      const prompt = restartPrompt(history(latest("notInserted"), retention));
      expect(choices(prompt)).toEqual(["Restart -> restart"]);
      expect(prompt.description).toContain("Your history is saved on this Mac");
    }
  });

  test("a saved history that failed to save asks for a copy like one kept in memory", () => {
    const prompt = restartPrompt(history(latest("notInserted"), "month", true));
    expect(choices(prompt)).toEqual(["Copy transcript and restart -> copyTranscriptAndRestart"]);
    expect(prompt.description).toContain("could not be saved");
    expect(prompt.description).not.toContain("will still be there");

    expect(choices(restartPrompt(history(latest("inserted"), "month", true)))).toEqual([
      "Restart -> restart",
      "Copy transcript and restart -> copyTranscriptAndRestart",
    ]);
  });

  test("an open prompt stays for a settled entry and withdraws when what it says would change", () => {
    const opened = history(latest("pending"), "memory");
    expect(samePrompt(opened, history(latest("inserted"), "memory"))).toBe(true);
    expect(samePrompt(opened, history({ ...latest("pending"), id: "s2" }, "memory"))).toBe(false);
    expect(samePrompt(opened, history(latest("pending"), "month"))).toBe(false);
    expect(samePrompt(opened, history(latest("pending"), "memory", true))).toBe(false);
    expect(samePrompt(history(null, "memory"), history(null, "memory"))).toBe(true);
  });
});

import { EventEmitter } from "node:events";

import type { UpdateCheckResult } from "electron-updater";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { UpdatesSnapshot } from "../shared/api.ts";
import { createUpdates, parseReleaseConfig, parseRestartRequest } from "./updates.ts";

function result(
  version = "0.0.2",
  isUpdateAvailable = true,
  releaseNotes: string | null = null,
): UpdateCheckResult {
  const updateInfo = {
    version,
    releaseNotes,
    files: [],
    path: "Voice.zip",
    sha512: "hash",
    releaseDate: "2026-09-26",
  };
  return { updateInfo, versionInfo: updateInfo, isUpdateAvailable };
}

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = false;
  allowDowngrade = true;
  channel = "latest";
  setFeedURL = vi.fn();
  checkForUpdates = vi.fn(async () => result());
  downloadUpdate = vi.fn(async () => ["Voice.zip"]);
  quitAndInstall = vi.fn();
}

function setup(options: { disabled?: boolean; nightly?: boolean } = {}) {
  const engine = new FakeUpdater();
  const loadEngine = vi.fn(() => engine);
  const snapshots: UpdatesSnapshot[] = [];
  const canRestart = vi.fn(() => true);
  const prepareRestart = vi.fn(async () => {});
  const onRestartFailure = vi.fn();
  const updates = createUpdates({
    loadEngine,
    release: {
      channel: options.nightly ? "nightly" : "stable",
      updateUrl: "https://downloads.example.com",
    },
    initial: {
      version: options.nightly ? "0.0.3-nightly.8" : "0.0.1",
      installedChannel: options.nightly ? "nightly" : "stable",
      channel: options.nightly ? "nightly" : "stable",
      status: options.disabled ? { kind: "disabled", reason: "Development" } : { kind: "idle" },
    },
    onChange: (snapshot) => snapshots.push(snapshot),
    canRestart,
    prepareRestart,
    onRestartFailure,
  });
  return {
    engine,
    loadEngine,
    snapshots,
    updates,
    canRestart,
    prepareRestart,
    onRestartFailure,
  };
}

afterEach(() => vi.useRealTimers());

describe("release configuration", () => {
  test("only accepts a public HTTPS base without credentials or query parameters", () => {
    expect(
      parseReleaseConfig({ channel: "nightly", updateUrl: "https://downloads.example.com/" }),
    ).toEqual({ channel: "nightly", updateUrl: "https://downloads.example.com" });
    for (const value of [
      null,
      {},
      { channel: "beta", updateUrl: "https://example.com" },
      { channel: "stable", updateUrl: "http://example.com" },
      { channel: "stable", updateUrl: "https://user:secret@example.com" },
      { channel: "stable", updateUrl: "https://example.com?token=secret" },
    ]) {
      expect(parseReleaseConfig(value)).toBeNull();
    }
  });
});

describe("restart requests", () => {
  test("accept a known choice with the transcript the user saw, and nothing else", () => {
    const last = { raw: "um ship it", text: "Ship it." };
    expect(parseRestartRequest({ choice: "copyTranscriptAndRestart", last })).toEqual({
      choice: "copyTranscriptAndRestart",
      last,
    });
    expect(parseRestartRequest({ choice: "restart", last: null })).toEqual({
      choice: "restart",
      last: null,
    });
    for (const value of [
      null,
      "restart",
      { choice: "restart" },
      { choice: "quit", last: null },
      { choice: "restart", last: { raw: "um ship it" } },
      { choice: "restart", last: { raw: 1, text: "Ship it." } },
    ]) {
      expect(parseRestartRequest(value)).toBeNull();
    }
  });
});

describe("updates", () => {
  test("automatically checks, downloads only when asked, and never installs on normal quit", async () => {
    vi.useFakeTimers();
    const { updates, engine } = setup();
    engine.checkForUpdates.mockResolvedValue(
      result(
        "0.0.2",
        true,
        "## What's Changed\n* fix: one by @someone in https://github.com/codlume/voice/pull/7",
      ),
    );
    const notes = ["fix: one by @someone in #7"];
    updates.start();
    expect(engine.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(updates.snapshot.status).toEqual({ kind: "available", version: "0.0.2", notes });
    expect(engine.downloadUpdate).not.toHaveBeenCalled();
    await updates.download();
    expect(updates.snapshot.status).toEqual({ kind: "ready", version: "0.0.2", notes });
    expect(engine.downloadUpdate).toHaveBeenCalledOnce();
    expect(engine.autoDownload).toBe(false);
    expect(engine.autoInstallOnAppQuit).toBe(false);
    expect(engine.quitAndInstall).not.toHaveBeenCalled();
    expect(engine.allowDowngrade).toBe(false);
    updates.dispose();
  });

  test("loads the updater at the first check, not at launch", async () => {
    vi.useFakeTimers();
    const { updates, loadEngine } = setup();
    updates.start();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(loadEngine).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await updates.check();
    expect(loadEngine).toHaveBeenCalledOnce();
    updates.dispose();
  });

  test("an updater that fails to load reports a failed check", async () => {
    const { updates, loadEngine } = setup();
    loadEngine.mockImplementationOnce(() => {
      throw new Error("Cannot find module 'electron-updater'");
    });
    await updates.check();
    expect(updates.snapshot.status.kind).toBe("failed");
    await updates.check();
    expect(updates.snapshot.status.kind).toBe("available");
  });

  test("an available update waits for the user and download acts only on it", async () => {
    vi.useFakeTimers();
    const { updates, engine } = setup();
    await updates.download();
    expect(engine.checkForUpdates).not.toHaveBeenCalled();
    updates.start();
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    await updates.check();
    expect(engine.checkForUpdates).toHaveBeenCalledOnce();
    expect(engine.downloadUpdate).not.toHaveBeenCalled();
    expect(updates.snapshot.status).toEqual({ kind: "available", version: "0.0.2", notes: [] });
    await updates.download();
    await updates.download();
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(updates.snapshot.status.kind).toBe("ready");
    expect(engine.checkForUpdates).toHaveBeenCalledOnce();
    expect(engine.downloadUpdate).toHaveBeenCalledOnce();
    updates.dispose();
  });

  test("download fetches the update the user saw without checking the feed again", async () => {
    const { updates, engine, snapshots } = setup();
    await updates.check();
    engine.checkForUpdates.mockResolvedValue(result("0.0.3"));
    const before = snapshots.length;
    await updates.download();
    expect(snapshots.slice(before).map((s) => s.status.kind)).toEqual(["downloading", "ready"]);
    expect(updates.snapshot.status).toEqual({ kind: "ready", version: "0.0.2", notes: [] });
    expect(engine.checkForUpdates).toHaveBeenCalledOnce();
  });

  test("development never contacts a feed, even on manual actions", async () => {
    vi.useFakeTimers();
    const { updates, engine, loadEngine } = setup({ disabled: true });
    updates.start();
    await updates.check();
    await updates.download();
    await updates.setChannel("nightly");
    await updates.restart();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(loadEngine).not.toHaveBeenCalled();
    expect(engine.setFeedURL).not.toHaveBeenCalled();
    expect(engine.checkForUpdates).not.toHaveBeenCalled();
    expect(engine.downloadUpdate).not.toHaveBeenCalled();
    expect(engine.quitAndInstall).not.toHaveBeenCalled();
    updates.dispose();
  });

  test("switching to Stable can replace a newer installed Nightly", async () => {
    const { updates, engine } = setup({ nightly: true });
    await updates.setChannel("stable");
    expect(engine.allowDowngrade).toBe(true);
    expect(engine.allowPrerelease).toBe(false);
    expect(engine.setFeedURL).toHaveBeenLastCalledWith({
      provider: "generic",
      url: "https://downloads.example.com/channels/stable/mac-arm64/",
      channel: "latest",
      useMultipleRangeRequest: false,
    });
    expect(updates.snapshot.status).toEqual({ kind: "available", version: "0.0.2", notes: [] });
    expect(engine.downloadUpdate).not.toHaveBeenCalled();
  });

  test("coalesces checks and drains an old download before changing feeds", async () => {
    const { updates, engine, snapshots } = setup();
    const download = Promise.withResolvers<string[]>();
    engine.downloadUpdate.mockReturnValueOnce(download.promise);
    await updates.check();
    const first = updates.download();
    await vi.waitFor(() => expect(engine.downloadUpdate).toHaveBeenCalledOnce());
    const duplicate = updates.check();
    expect(engine.checkForUpdates).toHaveBeenCalledOnce();
    engine.checkForUpdates.mockResolvedValue(result("0.0.3-nightly.9"));
    const switching = updates.setChannel("nightly");
    engine.emit("download-progress", { percent: 99 });
    expect(updates.snapshot.status.kind).toBe("checking");
    expect(engine.setFeedURL).toHaveBeenCalledOnce();
    download.resolve(["Voice.zip"]);
    await Promise.all([first, duplicate, switching]);
    expect(updates.snapshot.status).toEqual({
      kind: "available",
      version: "0.0.3-nightly.9",
      notes: [],
    });
    await updates.download();
    expect(updates.snapshot.status).toEqual({
      kind: "ready",
      version: "0.0.3-nightly.9",
      notes: [],
    });
    expect(
      snapshots.some(
        (s) =>
          s.channel === "nightly" &&
          (s.status.kind === "downloading" || s.status.kind === "ready") &&
          s.status.version === "0.0.2",
      ),
    ).toBe(false);
    expect(engine.listenerCount("download-progress")).toBe(0);
  });

  test("a failed download can be retried and a ready update survives duplicate checks", async () => {
    const { updates, engine } = setup();
    engine.downloadUpdate.mockRejectedValueOnce(new Error("offline"));
    await updates.check();
    await updates.download();
    expect(updates.snapshot.status).toEqual({
      kind: "failed",
      message: "The update could not be downloaded. Check your connection and try again.",
    });
    await updates.check();
    expect(updates.snapshot.status.kind).toBe("available");
    await updates.download();
    await updates.check();
    await updates.download();
    expect(updates.snapshot.status).toEqual({ kind: "ready", version: "0.0.2", notes: [] });
    expect(engine.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(engine.downloadUpdate).toHaveBeenCalledTimes(2);
  });

  test("carries the feed's release notes from the available update to the ready one", async () => {
    const { updates, engine, snapshots } = setup();
    engine.checkForUpdates.mockResolvedValue(
      result(
        "0.0.2",
        true,
        "## What's Changed\n* feat: add a setting by @someone in https://github.com/codlume/voice/pull/120\n\n**Full Changelog**: https://github.com/codlume/voice/compare/v0.0.1...v0.0.2",
      ),
    );
    await updates.check();
    const notes = ["feat: add a setting by @someone in #120"];
    expect(updates.snapshot.status).toEqual({ kind: "available", version: "0.0.2", notes });
    await updates.download();
    expect(snapshots.find((s) => s.status.kind === "downloading")?.status).toEqual({
      kind: "downloading",
      version: "0.0.2",
      notes,
      percent: 0,
    });
    expect(updates.snapshot.status).toEqual({ kind: "ready", version: "0.0.2", notes });
  });

  test("links the release page only while an update is pending", async () => {
    const { updates } = setup();
    expect(updates.releaseUrl()).toBeNull();
    await updates.check();
    expect(updates.releaseUrl()).toBe("https://github.com/codlume/voice/releases/tag/v0.0.2");
    await updates.download();
    expect(updates.releaseUrl()).toBe("https://github.com/codlume/voice/releases/tag/v0.0.2");
    await updates.restart();
    expect(updates.snapshot.status.kind).toBe("installing");
    expect(updates.releaseUrl()).toBeNull();
  });

  test("rejects a wrong-channel feed before downloading", async () => {
    const { updates, engine } = setup();
    engine.checkForUpdates.mockResolvedValue(result("0.0.2-nightly.1"));
    await updates.check();
    expect(updates.snapshot.status.kind).toBe("failed");
    expect(engine.downloadUpdate).not.toHaveBeenCalled();
  });

  test("does not install during dictation", async () => {
    const { updates, engine, canRestart, prepareRestart } = setup();
    await updates.check();
    await updates.download();
    canRestart.mockReturnValue(false);
    await expect(updates.restart()).rejects.toThrow("Finish dictation");
    expect(prepareRestart).not.toHaveBeenCalled();
    expect(engine.quitAndInstall).not.toHaveBeenCalled();
    expect(updates.snapshot.status.kind).toBe("ready");
  });

  test("runs the pre-install step only once a restart is allowed", async () => {
    const { updates, engine, canRestart } = setup();
    await updates.check();
    await updates.download();
    const beforeInstall = vi.fn();
    canRestart.mockReturnValue(false);
    await expect(updates.restart(beforeInstall)).rejects.toThrow("Finish dictation");
    expect(beforeInstall).not.toHaveBeenCalled();
    canRestart.mockReturnValue(true);
    await updates.restart(beforeInstall);
    expect(beforeInstall).toHaveBeenCalledOnce();
    expect(engine.quitAndInstall).toHaveBeenCalledOnce();
  });

  test("install waits for native shutdown exactly once", async () => {
    const { updates, engine, prepareRestart } = setup();
    await updates.check();
    await updates.download();
    const stopped = Promise.withResolvers<void>();
    prepareRestart.mockReturnValue(stopped.promise);
    const restarting = updates.restart();
    await vi.waitFor(() => expect(prepareRestart).toHaveBeenCalledOnce());
    await updates.restart();
    expect(engine.quitAndInstall).not.toHaveBeenCalled();
    await expect(updates.setChannel("nightly")).rejects.toThrow("restarting");
    stopped.resolve();
    await restarting;
    expect(engine.quitAndInstall).toHaveBeenCalledOnce();
    expect(updates.snapshot.status.kind).toBe("installing");
  });

  test("failed shutdown and native installation errors remain visible", async () => {
    const { updates, engine, prepareRestart, onRestartFailure } = setup();
    await updates.check();
    await updates.download();
    prepareRestart.mockRejectedValueOnce(new Error("timeout"));
    await expect(updates.restart()).rejects.toThrow("timeout");
    expect(engine.quitAndInstall).not.toHaveBeenCalled();
    expect(updates.snapshot.status.kind).toBe("failed");
    expect(onRestartFailure).toHaveBeenCalledOnce();
    await updates.check();
    await updates.download();
    await updates.restart();
    engine.emit("error", new Error("Squirrel failed"));
    expect(updates.snapshot.status.kind).toBe("failed");
    expect(onRestartFailure).toHaveBeenCalledTimes(2);
    await updates.check();
    expect(updates.snapshot.status.kind).toBe("available");
  });
});

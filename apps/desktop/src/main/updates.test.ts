import { EventEmitter } from "node:events";

import type { UpdateCheckResult } from "electron-updater";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { UpdatesSnapshot } from "../shared/api.ts";
import { createUpdates, parseReleaseConfig } from "./updates.ts";

function result(version = "0.0.2", isUpdateAvailable = true): UpdateCheckResult {
  const updateInfo = {
    version,
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
  const snapshots: UpdatesSnapshot[] = [];
  const canRestart = vi.fn(() => true);
  const confirmRestart = vi.fn(async () => true);
  const prepareRestart = vi.fn(async () => {});
  const onRestartFailure = vi.fn();
  const updates = createUpdates({
    engine,
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
    confirmRestart,
    prepareRestart,
    onRestartFailure,
  });
  return {
    engine,
    snapshots,
    updates,
    canRestart,
    confirmRestart,
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

describe("updates", () => {
  test("automatically checks and downloads, but never installs on normal quit", async () => {
    vi.useFakeTimers();
    const { updates, engine } = setup();
    updates.start();
    expect(engine.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(updates.snapshot.status).toEqual({ kind: "ready", version: "0.0.2" });
    expect(engine.downloadUpdate).toHaveBeenCalledOnce();
    expect(engine.autoInstallOnAppQuit).toBe(false);
    expect(engine.quitAndInstall).not.toHaveBeenCalled();
    expect(engine.allowDowngrade).toBe(false);
    updates.dispose();
  });

  test("development never contacts a feed, even on manual actions", async () => {
    vi.useFakeTimers();
    const { updates, engine } = setup({ disabled: true });
    updates.start();
    await updates.check();
    await updates.setChannel("nightly");
    await updates.restart();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(engine.setFeedURL).not.toHaveBeenCalled();
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
    expect(updates.snapshot.status).toEqual({ kind: "ready", version: "0.0.2" });
  });

  test("coalesces checks and drains an old download before changing feeds", async () => {
    const { updates, engine, snapshots } = setup();
    const download = Promise.withResolvers<string[]>();
    engine.downloadUpdate.mockReturnValueOnce(download.promise);
    const first = updates.check();
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
    expect(updates.snapshot.status).toEqual({ kind: "ready", version: "0.0.3-nightly.9" });
    expect(
      snapshots.some(
        (s) => s.channel === "nightly" && s.status.kind === "ready" && s.status.version === "0.0.2",
      ),
    ).toBe(false);
    expect(engine.listenerCount("download-progress")).toBe(0);
  });

  test("a failed download can be retried and a ready update survives duplicate checks", async () => {
    const { updates, engine } = setup();
    engine.downloadUpdate.mockRejectedValueOnce(new Error("offline"));
    await updates.check();
    expect(updates.snapshot.status.kind).toBe("failed");
    await updates.check();
    await updates.check();
    expect(updates.snapshot.status).toEqual({ kind: "ready", version: "0.0.2" });
    expect(engine.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  test("rejects a wrong-channel feed before downloading", async () => {
    const { updates, engine } = setup();
    engine.checkForUpdates.mockResolvedValue(result("0.0.2-nightly.1"));
    await updates.check();
    expect(updates.snapshot.status.kind).toBe("failed");
    expect(engine.downloadUpdate).not.toHaveBeenCalled();
  });

  test("does not install during dictation, including a session started during confirmation", async () => {
    const { updates, engine, canRestart, confirmRestart, prepareRestart } = setup();
    await updates.check();
    canRestart.mockReturnValue(false);
    await expect(updates.restart()).rejects.toThrow("Finish dictation");
    expect(confirmRestart).not.toHaveBeenCalled();
    canRestart.mockReturnValueOnce(true).mockReturnValue(false);
    await expect(updates.restart()).rejects.toThrow("Finish dictation");
    expect(prepareRestart).not.toHaveBeenCalled();
    expect(engine.quitAndInstall).not.toHaveBeenCalled();
    expect(updates.snapshot.status.kind).toBe("ready");
  });

  test("cancel preserves the ready update; install waits for native shutdown exactly once", async () => {
    const { updates, engine, confirmRestart, prepareRestart } = setup();
    await updates.check();
    confirmRestart.mockResolvedValueOnce(false);
    await updates.restart();
    expect(updates.snapshot.status.kind).toBe("ready");
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
    prepareRestart.mockRejectedValueOnce(new Error("timeout"));
    await expect(updates.restart()).rejects.toThrow("timeout");
    expect(engine.quitAndInstall).not.toHaveBeenCalled();
    expect(updates.snapshot.status.kind).toBe("failed");
    expect(onRestartFailure).toHaveBeenCalledOnce();
    await updates.check();
    await updates.restart();
    engine.emit("error", new Error("Squirrel failed"));
    expect(updates.snapshot.status.kind).toBe("failed");
    expect(onRestartFailure).toHaveBeenCalledTimes(2);
    await updates.check();
    expect(updates.snapshot.status.kind).toBe("ready");
  });
});

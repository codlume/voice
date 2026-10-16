import { EventEmitter } from "node:events";

import type { UpdateCheckResult, UpdateInfo } from "electron-updater";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { UpdateStatus, UpdatesSnapshot } from "../shared/api.ts";
import type { HistoryEntry, HistoryState, HistoryStatus } from "../shared/history.ts";
import {
  createUpdates,
  parseReleaseConfig,
  parseRestartRequest,
  restartRefusal,
} from "./updates.ts";

type Feed = { version: string; releaseNotes?: string };

const noNotes = { releases: [], omitted: 0 };
const notesFor = (version: string, item: string) => ({
  releases: [{ version, items: [item] }],
  omitted: 0,
});

/**
 * Models electron-updater 6.8.9: a check compares the feed with the installed version, an
 * available check stores what it found, downloadUpdate stages that stored release, and a check
 * or download that fails emits "error" before it rejects. Tests disturb `check` and `download`;
 * the library-facing methods wrap them so that every rejection, mocked or not, emits.
 */
class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = false;
  allowDowngrade = true;
  channel = "latest";
  installed = "0.0.1";
  feed: Feed = { version: "0.0.2" };
  found: UpdateInfo | null = null;
  staged: string | null = null;
  setFeedURL = vi.fn();
  check = vi.fn(() => this.read());
  download = vi.fn(() => this.fetch());
  quitAndInstall = vi.fn();
  checkForUpdates = () => this.emitOnReject(this.check());
  downloadUpdate = () => this.emitOnReject(this.download());

  private async emitOnReject<T>(operation: Promise<T>): Promise<T> {
    try {
      return await operation;
    } catch (error) {
      this.emit("error", error);
      throw error;
    }
  }

  async read(): Promise<UpdateCheckResult> {
    const updateInfo: UpdateInfo = {
      version: this.feed.version,
      releaseNotes: this.feed.releaseNotes ?? null,
      files: [],
      path: "Voice.zip",
      sha512: "hash",
      releaseDate: "2026-09-26",
    };
    const isUpdateAvailable = updateInfo.version !== this.installed;
    if (isUpdateAvailable) this.found = updateInfo;
    return { updateInfo, versionInfo: updateInfo, isUpdateAvailable };
  }

  async fetch(): Promise<string[]> {
    if (!this.found) throw new Error("Please check update first");
    this.staged = this.found.version;
    return ["Voice.zip"];
  }
}

function setup(options: { disabled?: boolean; nightly?: boolean } = {}) {
  const engine = new FakeUpdater();
  if (options.nightly) engine.installed = "0.0.3-nightly.8";
  const loadEngine = vi.fn(() => engine);
  const snapshots: UpdatesSnapshot[] = [];
  const canRestart = vi.fn(() => true);
  const prepareRestart = vi.fn(async () => {});
  const onRestartFailure = vi.fn();
  const initial: UpdatesSnapshot = {
    version: engine.installed,
    installedChannel: options.nightly ? "nightly" : "stable",
    channel: options.nightly ? "nightly" : "stable",
    status: options.disabled ? { kind: "disabled", reason: "Development" } : { kind: "idle" },
  };
  const updates = createUpdates({
    loadEngine,
    release: {
      channel: options.nightly ? "nightly" : "stable",
      updateUrl: "https://downloads.example.com",
    },
    initial,
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
    status: () => (snapshots.at(-1) ?? initial).status,
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

const entry = (status: HistoryStatus): HistoryEntry => ({
  id: "s1",
  at: 0,
  raw: "um ship it",
  text: "Ship it.",
  status,
});
const history = (
  latest: HistoryEntry | null,
  retention: HistoryState["retention"],
  saveFailed = false,
): HistoryState => ({ entries: latest ? [latest] : [], retention, saveFailed });

describe("restart requests", () => {
  test("accept a known choice with the newest transcript the user saw, and nothing else", () => {
    expect(parseRestartRequest({ choice: "copyTranscriptAndRestart", latest: "s1" })).toEqual({
      choice: "copyTranscriptAndRestart",
      latest: "s1",
    });
    expect(parseRestartRequest({ choice: "restart", latest: null })).toEqual({
      choice: "restart",
      latest: null,
    });
    for (const value of [
      null,
      "restart",
      { choice: "restart" },
      { choice: "quit", latest: null },
      { choice: "restart", latest: 1 },
      { choice: "restart", latest: { raw: "um ship it", text: "Ship it." } },
    ]) {
      expect(parseRestartRequest(value)).toBeNull();
    }
  });

  test("refuse a request made before a newer transcript arrived", () => {
    expect(
      restartRefusal({ choice: "restart", latest: null }, history(entry("inserted"), "memory")),
    ).toBe("A new transcript arrived. Check it, then restart.");
    expect(
      restartRefusal(
        { choice: "copyTranscriptAndRestart", latest: "s0" },
        history(entry("inserted"), "month"),
      ),
    ).toBe("A new transcript arrived. Check it, then restart.");
    expect(restartRefusal({ choice: "restart", latest: null }, history(null, "memory"))).toBeNull();
  });

  test("refuse a plain restart only when the newest transcript would be lost", () => {
    for (const status of ["pending", "notInserted"] as const) {
      expect(
        restartRefusal({ choice: "restart", latest: "s1" }, history(entry(status), "memory")),
      ).toBe("Your last transcript is not saved anywhere. Copy it, then restart.");
      expect(
        restartRefusal({ choice: "restart", latest: "s1" }, history(entry(status), "month", true)),
      ).toBe("Your last transcript is not saved anywhere. Copy it, then restart.");
      expect(
        restartRefusal({ choice: "restart", latest: "s1" }, history(entry(status), "month")),
      ).toBeNull();
      expect(
        restartRefusal(
          { choice: "copyTranscriptAndRestart", latest: "s1" },
          history(entry(status), "memory"),
        ),
      ).toBeNull();
    }
    expect(
      restartRefusal({ choice: "restart", latest: "s1" }, history(entry("inserted"), "memory")),
    ).toBeNull();
  });
});

describe("updates", () => {
  test("automatically checks, downloads only when asked, and never installs on normal quit", async () => {
    vi.useFakeTimers();
    const { updates, engine, status } = setup();
    engine.feed = {
      version: "0.0.2",
      releaseNotes:
        "## What's Changed\n* fix: one by @someone in https://github.com/codlume/voice/pull/7",
    };
    const notes = notesFor("0.0.2", "fix: one by @someone in #7");
    updates.start();
    expect(engine.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(status()).toEqual({ kind: "available", version: "0.0.2", notes });
    expect(engine.download).not.toHaveBeenCalled();
    await updates.download();
    expect(status()).toEqual({ kind: "ready", version: "0.0.2", notes });
    expect(engine.download).toHaveBeenCalledOnce();
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

  test("keeps one error listener across every kind of check and none after dispose", async () => {
    vi.useFakeTimers();
    const { updates, engine } = setup();
    engine.feed = { version: "0.0.1" };
    updates.start();
    await vi.advanceTimersByTimeAsync(15_000);
    await updates.check();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await updates.setChannel("nightly");
    expect(engine.check).toHaveBeenCalledTimes(4);
    expect(engine.listenerCount("error")).toBe(1);
    updates.dispose();
    expect(engine.listenerCount("error")).toBe(0);
  });

  test("an updater that fails to load reports a failed check", async () => {
    const { updates, loadEngine, status } = setup();
    loadEngine.mockImplementationOnce(() => {
      throw new Error("Cannot find module 'electron-updater'");
    });
    await updates.check();
    expect(status().kind).toBe("failed");
    await updates.check();
    expect(status().kind).toBe("available");
  });

  test("re-checks a standing offer silently and downloads only when asked", async () => {
    vi.useFakeTimers();
    const { updates, engine, snapshots, status } = setup();
    await updates.download();
    expect(engine.check).not.toHaveBeenCalled();
    updates.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(status()).toEqual({ kind: "available", version: "0.0.2", notes: noNotes });
    const offered = snapshots.length;
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await updates.check();
    expect(engine.check).toHaveBeenCalledTimes(3);
    expect(snapshots.length).toBe(offered);
    expect(engine.download).not.toHaveBeenCalled();
    await updates.download();
    expect(status()).toEqual({ kind: "ready", version: "0.0.2", notes: noNotes });
    const ready = snapshots.length;
    await updates.download();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await updates.check();
    expect(snapshots.length).toBe(ready);
    expect(engine.download).toHaveBeenCalledOnce();
    updates.dispose();
  });

  test("moves a standing offer to the release the feed now carries", async () => {
    const { updates, engine, snapshots } = setup();
    await updates.check();
    engine.feed = {
      version: "0.0.3",
      releaseNotes:
        "## What's Changed\n* feat: three by @someone in https://github.com/codlume/voice/pull/9",
    };
    const before = snapshots.length;
    await updates.check();
    expect(snapshots.slice(before).map((s) => s.status)).toEqual([
      {
        kind: "available",
        version: "0.0.3",
        notes: notesFor("0.0.3", "feat: three by @someone in #9"),
      },
    ]);
    expect(engine.download).not.toHaveBeenCalled();
  });

  test("withdraws an offer the feed no longer makes", async () => {
    const { updates, engine, snapshots } = setup();
    await updates.check();
    engine.feed = { version: engine.installed };
    const before = snapshots.length;
    await updates.check();
    expect(snapshots.slice(before).map((s) => s.status)).toEqual([{ kind: "current" }]);
  });

  test("keeps an offer through a failed check and a ready download through any check", async () => {
    const { updates, engine, snapshots, status } = setup();
    await updates.check();
    engine.check.mockRejectedValueOnce(new Error("offline"));
    const offered = snapshots.length;
    await updates.check();
    expect(snapshots.length).toBe(offered);
    expect(status()).toEqual({ kind: "available", version: "0.0.2", notes: noNotes });
    await updates.download();
    const ready = snapshots.length;
    engine.check.mockRejectedValueOnce(new Error("offline"));
    await updates.check();
    engine.feed = { version: engine.installed };
    await updates.check();
    engine.feed = { version: "0.0.3-nightly.1" };
    await updates.check();
    expect(snapshots.length).toBe(ready);
    expect(status()).toEqual({ kind: "ready", version: "0.0.2", notes: noNotes });
    expect(engine.download).toHaveBeenCalledOnce();
  });

  test("download re-reads the feed and fetches the release it now offers", async () => {
    const { updates, engine, snapshots } = setup();
    await updates.check();
    engine.feed = {
      version: "0.0.3",
      releaseNotes:
        "## What's Changed\n* feat: three by @someone in https://github.com/codlume/voice/pull/9",
    };
    const notes = notesFor("0.0.3", "feat: three by @someone in #9");
    const before = snapshots.length;
    await updates.download();
    expect(snapshots.slice(before).map((s) => s.status)).toEqual([
      { kind: "downloading", version: "0.0.2", notes: noNotes, percent: 0 },
      { kind: "downloading", version: "0.0.3", notes, percent: 0 },
      { kind: "ready", version: "0.0.3", notes },
    ]);
    expect(engine.staged).toBe("0.0.3");
  });

  test("download fetches nothing when the re-read fails or the feed withdrew the offer", async () => {
    for (const [disturb, end] of [
      [
        (engine: FakeUpdater) => engine.check.mockRejectedValueOnce(new Error("offline")),
        {
          kind: "failed",
          message: "The update could not be downloaded. Check your connection and try again.",
        },
      ],
      [
        (engine: FakeUpdater) => {
          engine.feed = { version: engine.installed };
        },
        { kind: "current" },
      ],
      [
        (engine: FakeUpdater) => {
          engine.feed = { version: "0.0.3-nightly.1" };
        },
        {
          kind: "failed",
          message: "The update could not be downloaded. Check your connection and try again.",
        },
      ],
    ] as const) {
      const { updates, engine, snapshots } = setup();
      await updates.check();
      disturb(engine);
      const before = snapshots.length;
      await updates.download();
      expect(snapshots.slice(before).map((s) => s.status)).toEqual([
        { kind: "downloading", version: "0.0.2", notes: noNotes, percent: 0 },
        end,
      ]);
      expect(engine.download).not.toHaveBeenCalled();
      expect(engine.staged).toBeNull();
    }
  });

  test("a check in flight when the restart begins publishes nothing and fetches nothing", async () => {
    const { updates, engine, snapshots, status } = setup();
    await updates.check();
    await updates.download();
    const gate = Promise.withResolvers<void>();
    engine.check.mockImplementationOnce(() => gate.promise.then(() => engine.read()));
    engine.feed = { version: "0.0.3" };
    const inFlight = updates.check();
    const restarting = updates.restart();
    expect(status()).toEqual({ kind: "installing", version: "0.0.2" });
    const before = snapshots.length;
    gate.resolve();
    await Promise.all([inFlight, restarting]);
    expect(snapshots.length).toBe(before);
    expect(engine.download).toHaveBeenCalledOnce();
    expect(engine.staged).toBe("0.0.2");
  });

  test("a check that fails while restarting is not an install failure, and the install waits for it", async () => {
    const { updates, engine, snapshots, status, prepareRestart, onRestartFailure } = setup();
    await updates.check();
    await updates.download();
    const gate = Promise.withResolvers<UpdateCheckResult>();
    engine.check.mockReturnValueOnce(gate.promise);
    const stopped = Promise.withResolvers<void>();
    prepareRestart.mockReturnValueOnce(stopped.promise);
    const inFlight = updates.check();
    const restarting = updates.restart();
    expect(status()).toEqual({ kind: "installing", version: "0.0.2" });
    stopped.resolve();
    await stopped.promise;
    expect(engine.quitAndInstall).not.toHaveBeenCalled();
    const before = snapshots.length;
    gate.reject(new Error("offline"));
    await Promise.all([inFlight, restarting]);
    expect(onRestartFailure).not.toHaveBeenCalled();
    expect(snapshots.length).toBe(before);
    expect(status()).toEqual({ kind: "installing", version: "0.0.2" });
    expect(engine.quitAndInstall).toHaveBeenCalledOnce();
    expect(engine.staged).toBe("0.0.2");
    engine.emit("error", new Error("Squirrel failed"));
    expect(status().kind).toBe("failed");
    expect(onRestartFailure).toHaveBeenCalledOnce();
  });

  test("a download asked for during a silent background check still happens", async () => {
    const { updates, engine, snapshots, status } = setup();
    await updates.check();
    const gate = Promise.withResolvers<void>();
    engine.check.mockReturnValueOnce(gate.promise.then(() => engine.read()));
    const poll = updates.check();
    expect(status()).toEqual({ kind: "available", version: "0.0.2", notes: noNotes });
    const before = snapshots.length;
    const clicked = updates.download();
    gate.resolve();
    await Promise.all([poll, clicked]);
    expect(snapshots.slice(before).map((s) => s.status)).toEqual([
      { kind: "downloading", version: "0.0.2", notes: noNotes, percent: 0 },
      { kind: "ready", version: "0.0.2", notes: noNotes },
    ]);
    expect(engine.staged).toBe("0.0.2");
  });

  test("development never contacts a feed, even on manual actions", async () => {
    vi.useFakeTimers();
    const { updates, engine, loadEngine, snapshots } = setup({ disabled: true });
    updates.start();
    await updates.check();
    await updates.download();
    await updates.setChannel("nightly");
    await updates.restart();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(snapshots.at(-1)).toMatchObject({ channel: "nightly", status: { kind: "disabled" } });
    expect(loadEngine).not.toHaveBeenCalled();
    expect(engine.setFeedURL).not.toHaveBeenCalled();
    expect(engine.check).not.toHaveBeenCalled();
    expect(engine.download).not.toHaveBeenCalled();
    expect(engine.quitAndInstall).not.toHaveBeenCalled();
    updates.dispose();
  });

  test("switching to Stable can replace a newer installed Nightly", async () => {
    const { updates, engine, status } = setup({ nightly: true });
    await updates.setChannel("stable");
    expect(engine.allowDowngrade).toBe(true);
    expect(engine.allowPrerelease).toBe(false);
    expect(engine.setFeedURL).toHaveBeenLastCalledWith({
      provider: "generic",
      url: "https://downloads.example.com/channels/stable/mac-arm64/",
      channel: "latest",
      useMultipleRangeRequest: false,
    });
    expect(status()).toEqual({ kind: "available", version: "0.0.2", notes: noNotes });
    expect(engine.download).not.toHaveBeenCalled();
  });

  test("coalesces checks and drains an old download before changing feeds", async () => {
    const { updates, engine, snapshots, status } = setup();
    const download = Promise.withResolvers<string[]>();
    engine.download.mockReturnValueOnce(download.promise);
    await updates.check();
    const first = updates.download();
    await vi.waitFor(() => expect(engine.download).toHaveBeenCalledOnce());
    const duplicate = updates.check();
    expect(engine.check).toHaveBeenCalledTimes(2);
    engine.feed = { version: "0.0.3-nightly.9" };
    const switching = updates.setChannel("nightly");
    engine.emit("download-progress", { percent: 99 });
    expect(status().kind).toBe("checking");
    expect(engine.setFeedURL.mock.lastCall?.[0].url).toContain("/channels/stable/");
    download.resolve(["Voice.zip"]);
    await Promise.all([first, duplicate, switching]);
    expect(status()).toEqual({
      kind: "available",
      version: "0.0.3-nightly.9",
      notes: noNotes,
    });
    await updates.download();
    expect(status()).toEqual({
      kind: "ready",
      version: "0.0.3-nightly.9",
      notes: noNotes,
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
    const { updates, engine, snapshots, status } = setup();
    engine.download.mockRejectedValueOnce(new Error("offline"));
    await updates.check();
    await updates.download();
    expect(status()).toEqual({
      kind: "failed",
      message: "The update could not be downloaded. Check your connection and try again.",
    });
    await updates.check();
    expect(status().kind).toBe("available");
    await updates.download();
    const ready = snapshots.length;
    await updates.check();
    await updates.download();
    expect(snapshots.length).toBe(ready);
    expect(status()).toEqual({ kind: "ready", version: "0.0.2", notes: noNotes });
    expect(engine.download).toHaveBeenCalledTimes(2);
  });

  test("re-downloads when the feed moves past a ready update, so the user restarts once", async () => {
    vi.useFakeTimers();
    const { updates, engine, snapshots, status } = setup({ nightly: true });
    engine.feed = { version: "0.0.3-nightly.9" };
    await updates.check();
    await updates.download();
    expect(status()).toEqual({ kind: "ready", version: "0.0.3-nightly.9", notes: noNotes });
    engine.feed = {
      version: "0.0.3-nightly.10",
      releaseNotes:
        "## What's Changed\n* fix: two by @someone in https://github.com/codlume/voice/pull/8",
    };
    const notes = notesFor("0.0.3-nightly.10", "fix: two by @someone in #8");
    let statusWhenFetchStarted: UpdateStatus | undefined;
    engine.download.mockImplementationOnce(() => {
      statusWhenFetchStarted = status();
      return engine.fetch();
    });
    const before = snapshots.length;
    updates.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(snapshots.slice(before).map((s) => s.status)).toEqual([
      { kind: "downloading", version: "0.0.3-nightly.10", notes, percent: 0 },
      { kind: "ready", version: "0.0.3-nightly.10", notes },
    ]);
    expect(statusWhenFetchStarted?.kind).toBe("downloading");
    expect(engine.staged).toBe("0.0.3-nightly.10");
    updates.dispose();
  });

  test("carries the feed's release notes from the available update to the ready one", async () => {
    const { updates, engine, snapshots, status } = setup();
    engine.feed = {
      version: "0.0.2",
      releaseNotes:
        "## What's Changed\n* feat: add a setting by @someone in https://github.com/codlume/voice/pull/120\n\n**Full Changelog**: https://github.com/codlume/voice/compare/v0.0.1...v0.0.2",
    };
    await updates.check();
    const notes = notesFor("0.0.2", "feat: add a setting by @someone in #120");
    expect(status()).toEqual({ kind: "available", version: "0.0.2", notes });
    await updates.download();
    expect(snapshots.find((s) => s.status.kind === "downloading")?.status).toEqual({
      kind: "downloading",
      version: "0.0.2",
      notes,
      percent: 0,
    });
    expect(status()).toEqual({ kind: "ready", version: "0.0.2", notes });
  });

  test("links the release page only while an update is pending", async () => {
    const { updates, status } = setup();
    expect(updates.releaseUrl()).toBeNull();
    await updates.check();
    expect(updates.releaseUrl()).toBe("https://github.com/codlume/voice/releases/tag/v0.0.2");
    await updates.download();
    expect(updates.releaseUrl()).toBe("https://github.com/codlume/voice/releases/tag/v0.0.2");
    await updates.restart();
    expect(status().kind).toBe("installing");
    expect(updates.releaseUrl()).toBeNull();
  });

  test("rejects a wrong-channel feed before downloading", async () => {
    const { updates, engine, status } = setup();
    engine.feed = { version: "0.0.2-nightly.1" };
    await updates.check();
    expect(status().kind).toBe("failed");
    expect(engine.download).not.toHaveBeenCalled();
  });

  test("does not install during dictation", async () => {
    const { updates, engine, canRestart, prepareRestart, status } = setup();
    await updates.check();
    await updates.download();
    canRestart.mockReturnValue(false);
    await expect(updates.restart()).rejects.toThrow("Finish dictation");
    expect(prepareRestart).not.toHaveBeenCalled();
    expect(engine.quitAndInstall).not.toHaveBeenCalled();
    expect(status().kind).toBe("ready");
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
    const { updates, engine, prepareRestart, status } = setup();
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
    expect(status().kind).toBe("installing");
  });

  test("failed shutdown and native installation errors remain visible", async () => {
    const { updates, engine, prepareRestart, onRestartFailure, status } = setup();
    await updates.check();
    await updates.download();
    prepareRestart.mockRejectedValueOnce(new Error("timeout"));
    await expect(updates.restart()).rejects.toThrow("timeout");
    expect(engine.quitAndInstall).not.toHaveBeenCalled();
    expect(status().kind).toBe("failed");
    expect(onRestartFailure).toHaveBeenCalledOnce();
    await updates.check();
    await updates.download();
    await updates.restart();
    engine.emit("error", new Error("Squirrel failed"));
    expect(status().kind).toBe("failed");
    expect(onRestartFailure).toHaveBeenCalledTimes(2);
    await updates.check();
    expect(status().kind).toBe("available");
  });
});

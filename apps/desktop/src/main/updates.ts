import type { AppUpdater } from "electron-updater";

import {
  pendingUpdate,
  type UpdateChannel,
  type UpdateStatus,
  type UpdatesSnapshot,
} from "../shared/api.ts";
import { releaseNoteItems } from "./release-notes.ts";

export type ReleaseConfig = { channel: UpdateChannel; updateUrl: string };

export function parseReleaseConfig(value: unknown): ReleaseConfig | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("channel" in value) || (value.channel !== "stable" && value.channel !== "nightly"))
    return null;
  if (!("updateUrl" in value) || typeof value.updateUrl !== "string") return null;
  try {
    const url = new URL(value.updateUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      return null;
    return { channel: value.channel, updateUrl: url.href.replace(/\/$/, "") };
  } catch {
    return null;
  }
}

type Engine = Pick<
  AppUpdater,
  | "autoDownload"
  | "autoInstallOnAppQuit"
  | "allowPrerelease"
  | "allowDowngrade"
  | "channel"
  | "setFeedURL"
  | "checkForUpdates"
  | "downloadUpdate"
  | "quitAndInstall"
> & {
  on: (...args: Parameters<AppUpdater["on"]>) => unknown;
  removeListener: (...args: Parameters<AppUpdater["removeListener"]>) => unknown;
};

export function createUpdates({
  engine,
  release,
  initial,
  onChange,
  canRestart,
  confirmRestart,
  prepareRestart,
  onRestartFailure,
}: {
  engine: Engine | null;
  release: ReleaseConfig | null;
  initial: UpdatesSnapshot;
  onChange: (snapshot: UpdatesSnapshot) => void;
  canRestart: () => boolean;
  confirmRestart: () => Promise<boolean>;
  prepareRestart: () => Promise<void>;
  onRestartFailure: () => void;
}) {
  let snapshot = initial;
  let generation = 0;
  let running: Promise<void> | null = null;
  let restarting = false;
  let disposed = false;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const enabled = engine !== null && release !== null && initial.status.kind !== "disabled";
  const installing = () => snapshot.status.kind === "installing";

  function publish(status: UpdateStatus) {
    if (disposed) return;
    snapshot = { ...snapshot, status };
    onChange(snapshot);
  }

  // Electron emits errors as well as rejecting operations. Keep a listener for errors
  // raised by Squirrel after quitAndInstall has returned.
  const onError = () => {
    if (snapshot.status.kind === "installing") {
      restarting = false;
      publish({
        kind: "failed",
        message: "The update could not be installed. Quit and reopen Voice, then try again.",
      });
      onRestartFailure();
    }
  };
  if (enabled) {
    engine.autoDownload = false;
    engine.autoInstallOnAppQuit = false;
    engine.on("error", onError);
  }

  async function performCheck(expectedGeneration: number, channel: UpdateChannel) {
    if (!engine || !release) return;
    const current = () => !disposed && generation === expectedGeneration;
    publish({ kind: "checking" });
    engine.setFeedURL({
      provider: "generic",
      url: `${release.updateUrl}/channels/${channel}/mac-arm64/`,
      channel: "latest",
      useMultipleRangeRequest: false,
    });
    engine.channel = "latest";
    engine.allowPrerelease = channel === "nightly";
    // The library's channel setter enables downgrades, even for ordinary checks.
    engine.allowDowngrade = channel !== snapshot.installedChannel;
    try {
      const result = await engine.checkForUpdates();
      if (!current()) return;
      if (!result) throw new Error("Updater did not return a result");
      if (!result.isUpdateAvailable) {
        publish({ kind: "current" });
        return;
      }
      const version = result.updateInfo.version;
      if ((channel === "nightly") !== version.includes("-nightly.")) {
        throw new Error("The update feed contains a different release channel");
      }
      publish({
        kind: "available",
        version,
        notes: releaseNoteItems(result.updateInfo.releaseNotes),
      });
    } catch {
      if (current())
        publish({
          kind: "failed",
          message: "Could not check for updates. Check your connection and try again.",
        });
    }
  }

  // The engine downloads the release its last check found. No check runs while an update
  // is available, so that is the release the user chose.
  async function performDownload(
    expectedGeneration: number,
    { version, notes }: Extract<UpdateStatus, { kind: "available" }>,
  ) {
    if (!engine) return;
    const current = () => !disposed && generation === expectedGeneration;
    publish({ kind: "downloading", version, notes, percent: 0 });
    const progress = ({ percent }: { percent: number }) => {
      if (current())
        publish({
          kind: "downloading",
          version,
          notes,
          percent: Math.max(0, Math.min(100, percent)),
        });
    };
    engine.on("download-progress", progress);
    try {
      await engine.downloadUpdate();
    } catch {
      if (current())
        publish({
          kind: "failed",
          message: "The update could not be downloaded. Check your connection and try again.",
        });
      return;
    } finally {
      engine.removeListener("download-progress", progress);
    }
    if (current()) publish({ kind: "ready", version, notes });
  }

  function run(task: (expectedGeneration: number) => Promise<void>): Promise<void> {
    if (!enabled || disposed || restarting) return Promise.resolve();
    if (running) return running;
    running = task(generation).finally(() => {
      running = null;
    });
    return running;
  }

  function check(): Promise<void> {
    const { kind } = snapshot.status;
    if (kind === "available" || kind === "ready") return Promise.resolve();
    return run((expectedGeneration) => performCheck(expectedGeneration, snapshot.channel));
  }

  function download(): Promise<void> {
    const update = snapshot.status;
    if (update.kind !== "available") return Promise.resolve();
    return run((expectedGeneration) => performDownload(expectedGeneration, update));
  }

  return {
    get snapshot() {
      return snapshot;
    },
    start() {
      if (!enabled || startupTimer || pollTimer || disposed) return;
      startupTimer = setTimeout(() => {
        void check();
      }, 15_000);
      pollTimer = setInterval(
        () => {
          void check();
        },
        4 * 60 * 60 * 1000,
      );
      startupTimer.unref();
      pollTimer.unref();
    },
    check,
    download,
    releaseUrl(): string | null {
      const update = pendingUpdate(snapshot.status);
      return (
        update &&
        `https://github.com/codlume/voice/releases/tag/v${encodeURIComponent(update.version)}`
      );
    },
    async setChannel(channel: UpdateChannel) {
      if (restarting) throw new Error("Voice is restarting for an update.");
      if (snapshot.channel === channel || disposed) return;
      generation += 1;
      const expectedGeneration = generation;
      snapshot = { ...snapshot, channel };
      publish(enabled ? { kind: "checking" } : snapshot.status);
      // The updater has one feed and one staged download. Drain the old operation
      // before changing it, and discard its progress and completion above.
      await running;
      if (expectedGeneration === generation) await check();
    },
    async restart() {
      if (!enabled || !engine || restarting || disposed || snapshot.status.kind !== "ready") return;
      if (!canRestart()) throw new Error("Finish dictation before restarting Voice.");
      const expectedGeneration = generation;
      const version = snapshot.status.version;
      restarting = true;
      try {
        if (!(await confirmRestart())) return;
        if (!canRestart() || expectedGeneration !== generation)
          throw new Error("Finish dictation before restarting Voice.");
        publish({ kind: "installing", version });
        await prepareRestart();
        engine.quitAndInstall();
      } catch (error) {
        if (installing()) {
          publish({
            kind: "failed",
            message:
              "Voice could not restart for the update. Quit and reopen Voice, then try again.",
          });
          onRestartFailure();
        }
        throw error;
      } finally {
        if (!installing()) restarting = false;
      }
    },
    dispose() {
      disposed = true;
      generation += 1;
      clearTimeout(startupTimer);
      clearInterval(pollTimer);
      engine?.removeListener("error", onError);
    },
  };
}

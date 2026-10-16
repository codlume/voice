import type { AppUpdater } from "electron-updater";

import {
  pendingUpdate,
  type ReleaseNotes,
  type RestartRequest,
  type UpdateChannel,
  type UpdateStatus,
  type UpdatesSnapshot,
} from "../shared/api.ts";
import { atRiskOnQuit, type HistoryState } from "../shared/history.ts";
import { notesSinceInstalled } from "./release-notes.ts";

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

export function parseRestartRequest(value: unknown): RestartRequest | null {
  if (typeof value !== "object" || value === null) return null;
  if (
    !("choice" in value) ||
    (value.choice !== "restart" && value.choice !== "copyTranscriptAndRestart")
  )
    return null;
  if (!("latest" in value)) return null;
  const { latest } = value;
  if (latest !== null && typeof latest !== "string") return null;
  return { choice: value.choice, latest };
}

/**
 * Why a restart has to wait, or null. The request was made against the newest entry the user saw,
 * so a newer one means they chose on stale facts, and a plain restart must not lose the only copy
 * of a transcript.
 */
export function restartRefusal(request: RestartRequest, history: HistoryState): string | null {
  if (request.latest !== (history.entries[0]?.id ?? null))
    return "A new transcript arrived. Check it, then restart.";
  if (request.choice === "restart" && atRiskOnQuit(history))
    return "Your last transcript is not saved anywhere. Copy it, then restart.";
  return null;
}

type CheckOutcome =
  | { kind: "offer"; version: string; notes: ReleaseNotes }
  | { kind: "none" }
  | { kind: "error" };

function reconcile(status: UpdateStatus, outcome: CheckOutcome): UpdateStatus {
  const standing = pendingUpdate(status);
  switch (outcome.kind) {
    case "offer": {
      const { version, notes } = outcome;
      if (standing?.version === version) return status;
      return standing && standing.kind !== "available"
        ? { kind: "downloading", version, notes, percent: 0 }
        : { kind: "available", version, notes };
    }
    case "none":
      return status.kind === "ready" ? status : { kind: "current" };
    case "error":
      if (status.kind === "downloading")
        return {
          kind: "failed",
          message: "The update could not be downloaded. Check your connection and try again.",
        };
      return standing
        ? status
        : {
            kind: "failed",
            message: "Could not check for updates. Check your connection and try again.",
          };
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
  loadEngine,
  release,
  initial,
  onChange,
  canRestart,
  prepareRestart,
  onRestartFailure,
}: {
  loadEngine: (() => Engine) | null;
  release: ReleaseConfig | null;
  initial: UpdatesSnapshot;
  onChange: (snapshot: UpdatesSnapshot) => void;
  canRestart: () => boolean;
  prepareRestart: () => Promise<void>;
  onRestartFailure: () => void;
}) {
  let snapshot = initial;
  let engine: Engine | undefined;
  let generation = 0;
  let running: Promise<void> | null = null;
  let restarting = false;
  let disposed = false;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const enabled = loadEngine !== null && release !== null && initial.status.kind !== "disabled";
  const installing = () => snapshot.status.kind === "installing";

  function publish(status: UpdateStatus) {
    if (disposed) return;
    snapshot = { ...snapshot, status };
    onChange(snapshot);
  }

  // electron-updater emits errors as well as rejecting operations. Keep a listener for errors
  // raised by Squirrel after quitAndInstall has returned.
  const onError = () => {
    if (installing()) {
      restarting = false;
      publish({
        kind: "failed",
        message: "The update could not be installed. Quit and reopen Voice, then try again.",
      });
      onRestartFailure();
    }
  };
  function loadedEngine(load: () => Engine): Engine {
    if (engine) return engine;
    engine = load();
    engine.autoDownload = false;
    engine.autoInstallOnAppQuit = false;
    engine.on("error", onError);
    return engine;
  }

  const stillApplies = (expectedGeneration: number) =>
    !disposed && !restarting && generation === expectedGeneration;

  async function readFeed(channel: UpdateChannel): Promise<CheckOutcome> {
    try {
      if (!loadEngine || !release) throw new Error("Updates are disabled");
      const updater = loadedEngine(loadEngine);
      updater.setFeedURL({
        provider: "generic",
        url: `${release.updateUrl}/channels/${channel}/mac-arm64/`,
        channel: "latest",
        useMultipleRangeRequest: false,
      });
      updater.channel = "latest";
      updater.allowPrerelease = channel === "nightly";
      // The library's channel setter enables downgrades, even for ordinary checks.
      updater.allowDowngrade = channel !== snapshot.installedChannel;
      const result = await updater.checkForUpdates();
      if (!result) throw new Error("Updater did not return a result");
      if (!result.isUpdateAvailable) return { kind: "none" };
      const version = result.updateInfo.version;
      if ((channel === "nightly") !== version.includes("-nightly.")) {
        throw new Error("The update feed contains a different release channel");
      }
      return {
        kind: "offer",
        version,
        notes: notesSinceInstalled(result.updateInfo, snapshot.version),
      };
    } catch {
      return { kind: "error" };
    }
  }

  async function performCheck(expectedGeneration: number) {
    const outcome = await readFeed(snapshot.channel);
    if (!stillApplies(expectedGeneration)) return;
    const next = reconcile(snapshot.status, outcome);
    if (next !== snapshot.status) publish(next);
    if (next.kind === "downloading") await performDownload(expectedGeneration, next);
  }

  async function performDownload(
    expectedGeneration: number,
    { version, notes }: Extract<UpdateStatus, { kind: "downloading" }>,
  ) {
    if (!engine) return;
    const progress = ({ percent }: { percent: number }) => {
      if (stillApplies(expectedGeneration))
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
      if (stillApplies(expectedGeneration))
        publish({
          kind: "failed",
          message: "The update could not be downloaded. Check your connection and try again.",
        });
      return;
    } finally {
      engine.removeListener("download-progress", progress);
    }
    if (stillApplies(expectedGeneration)) publish({ kind: "ready", version, notes });
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
    return run((expectedGeneration) => {
      if (!pendingUpdate(snapshot.status)) publish({ kind: "checking" });
      return performCheck(expectedGeneration);
    });
  }

  function download(): Promise<void> {
    const update = snapshot.status;
    if (update.kind !== "available") return Promise.resolve();
    return run((expectedGeneration) => {
      // The engine downloads whatever its last check found, and the feed may have moved since
      // the user saw this offer. Re-read it first; a newer release replaces the offer.
      publish({ kind: "downloading", version: update.version, notes: update.notes, percent: 0 });
      return performCheck(expectedGeneration);
    });
  }

  return {
    start() {
      if (!enabled || startupTimer || pollTimer || disposed) return;
      startupTimer = setTimeout(() => {
        void check();
      }, 15_000);
      pollTimer = setInterval(
        () => {
          void check();
        },
        60 * 60 * 1000,
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
    async restart(beforeInstall?: () => void) {
      if (!enabled || !engine || restarting || disposed || snapshot.status.kind !== "ready") return;
      if (!canRestart()) throw new Error("Finish dictation before restarting Voice.");
      const version = snapshot.status.version;
      restarting = true;
      try {
        beforeInstall?.();
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

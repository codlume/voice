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

const CHECK_FAILED: UpdateStatus = {
  kind: "failed",
  message: "Could not check for updates. Check your connection and try again.",
};
const DOWNLOAD_FAILED: UpdateStatus = {
  kind: "failed",
  message: "The update could not be downloaded. Check your connection and try again.",
};

/** Returns `status` itself when the outcome changes nothing, so publish() can skip it. */
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
      if (status.kind === "downloading") return DOWNLOAD_FAILED;
      return standing ? status : CHECK_FAILED;
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
  whenIdle,
  canRestart,
  prepareRestart,
  onRestartFailure,
}: {
  loadEngine: (() => Engine) | null;
  release: ReleaseConfig | null;
  initial: UpdatesSnapshot;
  onChange: (snapshot: UpdatesSnapshot) => void;
  whenIdle: (task: () => void) => void;
  canRestart: () => boolean;
  prepareRestart: () => Promise<void>;
  onRestartFailure: () => void;
}) {
  type Feed = { loadEngine: () => Engine; release: ReleaseConfig };
  const enabled: Feed | null =
    loadEngine && release && initial.status.kind !== "disabled" ? { loadEngine, release } : null;
  let snapshot = initial;
  let engine: Engine | undefined;
  // Bumped whenever the world moves on (channel switch, restart, dispose) so that whatever an
  // in-flight check or download reports afterwards is discarded.
  let generation = 0;
  let running: Promise<void> | null = null;
  let disposed = false;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const installing = () => snapshot.status.kind === "installing";
  const stillApplies = (expectedGeneration: number) => generation === expectedGeneration;

  // Publishing the status object that already stands would reopen a card the user dismissed.
  function publish(status: UpdateStatus, channel = snapshot.channel) {
    if (disposed || (status === snapshot.status && channel === snapshot.channel)) return;
    snapshot = { ...snapshot, channel, status };
    onChange(snapshot);
  }

  // electron-updater emits errors as well as rejecting operations. Keep a listener for errors
  // raised by Squirrel after quitAndInstall has returned; one raised by a check or download that
  // is still in flight belongs to that operation.
  const onError = () => {
    if (installing() && running === null) {
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

  async function readFeed(feed: Feed, channel: UpdateChannel): Promise<CheckOutcome> {
    try {
      const updater = loadedEngine(feed.loadEngine);
      updater.setFeedURL({
        provider: "generic",
        url: `${feed.release.updateUrl}/channels/${channel}/mac-arm64/`,
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

  type Started = "user" | "check";

  async function performCheck(feed: Feed, expectedGeneration: number, started: Started) {
    const outcome = await readFeed(feed, snapshot.channel);
    if (!stillApplies(expectedGeneration)) return;
    const next = reconcile(snapshot.status, outcome);
    publish(next);
    if (next.kind === "downloading") await performDownload(expectedGeneration, next, started);
  }

  async function performDownload(
    expectedGeneration: number,
    { version, notes }: Extract<UpdateStatus, { kind: "downloading" }>,
    started: Started,
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
      // A failed download also drops the release electron-updater had staged, so a re-download
      // over a ready update that fails leaves nothing to install.
      if (stillApplies(expectedGeneration))
        publish(started === "user" ? DOWNLOAD_FAILED : { kind: "available", version, notes });
      return;
    } finally {
      engine.removeListener("download-progress", progress);
    }
    if (stillApplies(expectedGeneration)) publish({ kind: "ready", version, notes });
  }

  function run(task: (feed: Feed, expectedGeneration: number) => Promise<void>): Promise<void> {
    if (!enabled || disposed || installing()) return Promise.resolve();
    if (running) return running;
    running = task(enabled, generation).finally(() => {
      running = null;
    });
    return running;
  }

  function check(): Promise<void> {
    return run((feed, expectedGeneration) => {
      if (!pendingUpdate(snapshot.status)) publish({ kind: "checking" });
      return performCheck(feed, expectedGeneration, "check");
    });
  }

  async function download(): Promise<void> {
    if (snapshot.status.kind !== "available") return;
    // A background check re-reads the feed without changing the status, so the Download button
    // stays live while it runs. The click must wait for it rather than be coalesced into it.
    await running;
    const update = snapshot.status;
    if (update.kind !== "available") return;
    await run((feed, expectedGeneration) => {
      // The engine downloads whatever its last check found, and the feed may have moved since
      // the user saw this offer. Re-read it first; a newer release replaces the offer.
      publish({ kind: "downloading", version: update.version, notes: update.notes, percent: 0 });
      return performCheck(feed, expectedGeneration, "user");
    });
  }

  // The first check loads electron-updater, which blocks main for tens of milliseconds, and a key
  // press on its way to capture would wait behind it. A check the user asks for runs at once: it
  // came from the hub or the tray, so no session is under way, and a Checking status must mean it.
  // One function for every poll, so the polls that come due during one long run fold into one check.
  const backgroundCheck = () => void check();
  const scheduledCheck = () => whenIdle(backgroundCheck);

  return {
    start() {
      if (!enabled || startupTimer || pollTimer || disposed) return;
      startupTimer = setTimeout(scheduledCheck, 15_000);
      pollTimer = setInterval(scheduledCheck, 60 * 60 * 1000);
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
      if (installing()) throw new Error("Voice is restarting for an update.");
      if (snapshot.channel === channel || disposed) return;
      generation += 1;
      const expectedGeneration = generation;
      publish(enabled ? { kind: "checking" } : snapshot.status, channel);
      // The updater has one feed and one staged download. Drain the old operation
      // before changing it, and discard its progress and completion above.
      await running;
      if (expectedGeneration === generation) await check();
    },
    async restart(beforeInstall?: () => Promise<void>) {
      if (!engine || disposed || snapshot.status.kind !== "ready")
        throw new Error("No update is ready to install.");
      if (!canRestart()) throw new Error("Finish dictation before restarting Voice.");
      const { version } = snapshot.status;
      // The copy must land before the quit, or the transcript it carries is lost with the app.
      if (beforeInstall) await beforeInstall();
      generation += 1;
      publish({ kind: "installing", version });
      try {
        await prepareRestart();
        // A check may still be in flight from the hourly poll. Let it settle so that nothing of
        // ours touches the engine during the install and a later error can only be Squirrel's.
        await running;
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

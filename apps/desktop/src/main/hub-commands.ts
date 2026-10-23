// Everything the hub window can ask main to do. Each handler checks its arguments at this
// boundary and hands the work to the module that owns it; nothing here holds state of its own.
import { app, clipboard, shell } from "electron";

import {
  Channel,
  parseTranscriptVersion,
  type HubApi,
  type PermissionKind,
  type RestartRequest,
  type Settings,
} from "../shared/api.ts";
import { parseBundleIds } from "../shared/app-categories.ts";
import { copyText, parseHistoryRetention } from "../shared/history.ts";
import { models, type Model, type ModelId } from "../shared/models.ts";
import { parseAccountName, type createAccount } from "./account.ts";
import type { Log } from "./diagnostics-scrub.ts";
import type { History } from "./history.ts";
import type { InsightsStore } from "./insights.ts";
import type { InstalledApps } from "./installed-apps.ts";
import type { Commands } from "./ipc.ts";
import type { MicrophoneTest } from "./microphone-test.ts";
import { editAssignments, type SettingsQueue } from "./settings-queue.ts";
import { applyPatch, parseSettingsPatch } from "./settings.ts";
import { toSnapshot, type Store } from "./store.ts";
import type { Transforms } from "./transforms.ts";
import { parseRestartRequest, type createUpdates } from "./updates.ts";

const LOGIN_ITEMS_PANE = "x-apple.systempreferences:com.apple.LoginItems-Settings.extension";

const isPermissionKind = (kind: unknown): kind is PermissionKind =>
  kind === "microphone" || kind === "accessibility";

export type HubCommandDeps = {
  store: Store;
  development: boolean;
  running: () => boolean;
  assertNotRestarting: () => void;
  updates: Pick<ReturnType<typeof createUpdates>, "check" | "download" | "releaseUrl">;
  restartForUpdate: (request: RestartRequest) => Promise<void>;
  updateSettings: (change: (settings: Settings) => Settings) => Promise<void>;
  requestPermission: (kind: PermissionKind) => void;
  refreshLoginItem: () => void;
  microphoneTest: Pick<MicrophoneTest, "start" | "stop">;
  modelControls: Record<ModelId, { install(): void; uninstall(): Promise<void> }>;
  assertCanUninstall: (model: Model) => void;
  history: History;
  transforms: Pick<Transforms, "lastTransform" | "copyLastTransform">;
  account: ReturnType<typeof createAccount>;
  insights: InsightsStore;
  installedApps: InstalledApps;
  settingsQueue: SettingsQueue;
  log: Log;
};

export function registerHubCommands(hubCommands: Commands<HubApi>, deps: HubCommandDeps) {
  const { store, updates, history, account, insights, installedApps, transforms, log } = deps;
  hubCommands.handle(Channel.getSnapshot, () => toSnapshot(store.state));
  hubCommands.handle(Channel.checkForUpdates, () => updates.check());
  hubCommands.handle(Channel.downloadUpdate, () => updates.download());
  hubCommands.handle(Channel.restartForUpdate, async (_event, value: unknown) => {
    const request = parseRestartRequest(value);
    if (request) await deps.restartForUpdate(request);
  });
  hubCommands.handle(Channel.openRelease, () => {
    const url = updates.releaseUrl();
    if (url) void shell.openExternal(url);
  });
  hubCommands.handle(Channel.updateSettings, (_event, raw) => {
    const patch = parseSettingsPatch(raw);
    return deps.updateSettings((previous) => applyPatch(previous, patch));
  });
  hubCommands.handle(Channel.requestPermission, (_event, kind) => {
    if (isPermissionKind(kind)) deps.requestPermission(kind);
  });
  hubCommands.handle(Channel.setOpenAtLogin, (_event, on: unknown) => {
    if (deps.development) return;
    const openAtLogin = on === true;
    // Registering again does not approve the item. Only the user can, in Login Items.
    if (openAtLogin && store.state.loginItem === "needsApproval") {
      void shell.openExternal(LOGIN_ITEMS_PANE);
      return;
    }
    app.setLoginItemSettings({ openAtLogin });
    deps.refreshLoginItem();
  });
  hubCommands.handle(Channel.startMicrophoneTest, () => {
    if (deps.running()) deps.microphoneTest.start();
  });
  hubCommands.handle(Channel.stopMicrophoneTest, () => deps.microphoneTest.stop());
  hubCommands.handle(Channel.installModel, (_event, id: unknown) => {
    const model = models.find((candidate) => candidate.id === id);
    if (model && deps.running()) deps.modelControls[model.id].install();
  });
  hubCommands.handle(Channel.uninstallModel, (_event, id: unknown) => {
    const model = models.find((candidate) => candidate.id === id);
    if (!model) return;
    deps.assertCanUninstall(model);
    return deps.modelControls[model.id].uninstall();
  });
  // The first list the hub sees is the loaded one, so an empty list means empty, not pending.
  hubCommands.handle(Channel.getHistory, () => history.loaded().then(history.state));
  hubCommands.handle(Channel.copyHistoryEntry, (_event, id: unknown, value: unknown) => {
    const version = parseTranscriptVersion(value);
    if (typeof id !== "string" || version === null) return;
    const entry = history.entries().find((candidate) => candidate.id === id);
    if (!entry) throw new Error("This transcript is no longer in your history.");
    clipboard.writeText(version === "raw" ? entry.raw : copyText(entry));
  });
  hubCommands.handle(Channel.getLastTransform, () => transforms.lastTransform());
  hubCommands.handle(Channel.copyLastTransform, (_event, which: unknown) => {
    if (which !== "before" && which !== "after") return;
    transforms.copyLastTransform(which);
  });
  hubCommands.handle(Channel.deleteHistoryEntry, async (_event, id: unknown) => {
    if (typeof id !== "string") return;
    try {
      await history.remove(id);
    } catch (error) {
      log(`history: delete failed (${String(error)})`);
      throw new Error("Could not delete this transcript from the saved history. Try again.", {
        cause: error,
      });
    }
  });
  hubCommands.handle(Channel.clearHistory, async () => {
    try {
      await history.clear();
    } catch (error) {
      log(`history: clear failed (${String(error)})`);
      throw new Error("Could not clear the saved history. Try again.", { cause: error });
    }
  });
  hubCommands.handle(Channel.setHistoryRetention, async (_event, value: unknown) => {
    const retention = parseHistoryRetention(value);
    if (retention === null) return;
    deps.assertNotRestarting();
    try {
      await history.setRetention(retention);
    } catch (error) {
      log(`history: retention change failed (${String(error)})`);
      throw new Error("Could not change where your history is kept. Try again.", {
        cause: error,
      });
    }
  });
  hubCommands.handle(Channel.signIn, () => {
    deps.assertNotRestarting();
    return account.signIn();
  });
  hubCommands.handle(Channel.submitSignInCode, (_event, code: unknown) =>
    account.submitSignInCode(typeof code === "string" ? code : ""),
  );
  hubCommands.handle(Channel.cancelSignIn, () => account.cancelSignIn());
  hubCommands.handle(Channel.signOut, () => account.signOut());
  hubCommands.handle(Channel.dismissAccountError, () => account.dismissError());
  hubCommands.handle(Channel.updateAccountName, (_event, name: unknown) =>
    account.updateName(parseAccountName(name)),
  );
  hubCommands.handle(Channel.requestAccountDeletion, () => account.requestDeletion());
  hubCommands.handle(Channel.confirmAccountDeletion, () => account.confirmDeletion());
  hubCommands.handle(Channel.cancelAccountDeletion, () => account.cancelDeletion());
  hubCommands.handle(Channel.retryAccountDeletion, () => account.retryDeletion());
  hubCommands.handle(Channel.getInsights, () => insights.get());
  hubCommands.handle(Channel.getInstalledApps, () => installedApps.list());
  hubCommands.handle(Channel.getAppIcons, (_event, raw: unknown) =>
    installedApps.icons(parseBundleIds(raw)),
  );
  hubCommands.handle(Channel.editAssignments, async (_event, raw: unknown) => {
    deps.assertNotRestarting();
    await editAssignments(deps.settingsQueue, raw);
  });
  hubCommands.handle(Channel.clearInsights, async () => {
    try {
      await insights.clear();
    } catch (error) {
      log(`insights: clear failed (${String(error)})`);
      throw new Error("Could not clear insights. Try again.", { cause: error });
    }
  });
}

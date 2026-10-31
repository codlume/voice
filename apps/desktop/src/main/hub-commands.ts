import { writeFile } from "node:fs/promises";

import { app, BrowserWindow, clipboard, dialog, shell } from "electron";

import {
  Channel,
  parseTranscriptVersion,
  type HubApi,
  type MeetingControls,
  type PermissionKind,
  type RestartRequest,
  type Settings,
} from "../shared/api.ts";
import { parseBundleIds } from "../shared/app-categories.ts";
import { copyText, parseHistoryRetention } from "../shared/history.ts";
import { meetingMarkdown } from "../shared/meeting-markdown.ts";
import {
  parseFolderDraft,
  parseFolderId,
  parseMeetingId,
  parseMeetingsSettingsPatch,
  renameSpeaker,
  retitle,
  titleText,
  type MeetingCommandResult,
  type MeetingId,
  type SpeakerId,
} from "../shared/meetings.ts";
import { models, type Model, type ModelId } from "../shared/models.ts";
import { parseAccountName, type createAccount } from "./account.ts";
import type { Log } from "./diagnostics-scrub.ts";
import type { History } from "./history.ts";
import type { InsightsStore } from "./insights.ts";
import type { InstalledApps } from "./installed-apps.ts";
import type { Commands } from "./ipc.ts";
import type { MeetingRecorder } from "./meeting-recorder.ts";
import { dismissBanner } from "./meeting-focus.ts";
import type { MeetingsStore } from "./meetings-store.ts";
import type { MicrophoneTest } from "./microphone-test.ts";
import { editAssignments, type SettingsQueue } from "./settings-queue.ts";
import { applyPatch, parseSettingsPatch } from "./settings.ts";
import { toSnapshot, type Store } from "./store.ts";
import type { Transforms } from "./transforms.ts";
import { parseRestartRequest, type createUpdates } from "./updates.ts";

const LOGIN_ITEMS_PANE = "x-apple.systempreferences:com.apple.LoginItems-Settings.extension";

const isPermissionKind = (kind: unknown): kind is PermissionKind =>
  kind === "microphone" || kind === "accessibility" || kind === "systemAudio";

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
  meetings: MeetingsStore;
  meetingRecorder: MeetingRecorder;
  openNotepad: () => void;
  log: Log;
};

const GONE: MeetingCommandResult = {
  kind: "refused",
  message: "This meeting is no longer on this Mac.",
};
// Characters Finder or the save panel refuse in a file name.
const UNSAFE_FILE_NAME = /[/\\:*?"<>|]/g;

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
  registerMeetingCommands(hubCommands, deps);
  hubCommands.handle(Channel.clearInsights, async () => {
    try {
      await insights.clear();
    } catch (error) {
      log(`insights: clear failed (${String(error)})`);
      throw new Error("Could not clear insights. Try again.", { cause: error });
    }
  });
}

const savingFor =
  (log: Log) =>
  async <T>(what: string, failure: string, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      log(`meetings: ${what} failed (${String(error)})`);
      throw new Error(failure, { cause: error });
    }
  };

const withMeeting =
  (command: (id: MeetingId) => Promise<MeetingCommandResult>) =>
  (_event: unknown, raw: unknown) => {
    const id = parseMeetingId(raw);
    return id ? command(id) : GONE;
  };

type MeetingControlDeps = Pick<HubCommandDeps, "meetings" | "meetingRecorder" | "log">;

/** The commands the Voice window and the notepad both send about one meeting. */
export function registerMeetingControls(
  commands: Commands<MeetingControls>,
  { meetings, meetingRecorder: recorder, log }: MeetingControlDeps,
) {
  const saving = savingFor(log);
  commands.handle(Channel.getMeeting, async (_event, raw: unknown) => {
    const id = parseMeetingId(raw);
    const meeting = id && meetings.get(id);
    if (!id || !meeting) return null;
    return { meeting, transcript: await meetings.transcript(id) };
  });
  commands.handle(Channel.updateMeetingNotes, async (_event, raw: unknown, notes: unknown) => {
    const id = parseMeetingId(raw);
    if (!id || typeof notes !== "string") return;
    await saving("notes", "Could not save your thoughts. Try again.", () =>
      meetings.update(id, (meeting) => (meeting.notes === notes ? meeting : { ...meeting, notes })),
    );
  });
  commands.handle(Channel.pauseMeeting, withMeeting(recorder.pause));
  commands.handle(Channel.resumeMeeting, withMeeting(recorder.resume));
  commands.handle(Channel.stopMeeting, withMeeting(recorder.stop));
  commands.handle(Channel.keepMeeting, withMeeting(recorder.keep));
  commands.handle(Channel.discardMeeting, withMeeting(recorder.discard));
}

function registerMeetingCommands(hubCommands: Commands<HubApi>, deps: HubCommandDeps) {
  const { meetings, meetingRecorder: recorder, log } = deps;
  const saving = savingFor(log);
  registerMeetingControls(hubCommands, deps);
  async function markdownOf(id: MeetingId) {
    const meeting = meetings.get(id);
    if (!meeting) throw new Error("This meeting is no longer on this Mac.");
    return { meeting, markdown: meetingMarkdown(meeting, await meetings.transcript(id)) };
  }

  hubCommands.handle(Channel.getMeetings, () => meetings.loaded().then(meetings.state));
  hubCommands.handle(Channel.renameMeeting, async (_event, raw: unknown, title: unknown) => {
    const id = parseMeetingId(raw);
    if (!id || typeof title !== "string") return;
    await saving("rename", "Could not rename this meeting. Try again.", () =>
      meetings.update(id, (meeting) => {
        const { folders, settings } = meetings.state();
        return retitle(meeting, title, folders, settings);
      }),
    );
  });
  hubCommands.handle(
    Channel.renameMeetingSpeaker,
    async (_event, raw: unknown, speakerId: unknown, name: unknown) => {
      const id = parseMeetingId(raw);
      if (!id || typeof speakerId !== "string" || typeof name !== "string") return;
      await saving("speaker rename", "Could not rename this speaker. Try again.", () =>
        meetings.update(id, (meeting) => renameSpeaker(meeting, speakerId as SpeakerId, name)),
      );
    },
  );
  hubCommands.handle(Channel.deleteMeeting, async (_event, raw: unknown) => {
    const id = parseMeetingId(raw);
    if (!id) return;
    await saving("delete", "Could not delete this meeting. Try again.", () => recorder.remove(id));
  });
  hubCommands.handle(Channel.createFolder, async (_event, raw: unknown) => {
    const draft = parseFolderDraft(raw);
    if (!draft) throw new Error("Name the folder first.");
    return saving("folder create", "Could not create this folder. Try again.", () =>
      meetings.createFolder(draft),
    );
  });
  hubCommands.handle(Channel.updateFolder, async (_event, raw: unknown, rawDraft: unknown) => {
    const id = parseFolderId(raw);
    const draft = parseFolderDraft(rawDraft);
    if (!id || !draft) return;
    await saving("folder update", "Could not change this folder. Try again.", () =>
      meetings.updateFolder(id, draft),
    );
  });
  hubCommands.handle(Channel.deleteFolder, async (_event, raw: unknown) => {
    const id = parseFolderId(raw);
    if (!id) return;
    await saving("folder delete", "Could not delete this folder. Try again.", () =>
      meetings.removeFolder(id),
    );
  });
  hubCommands.handle(
    Channel.setMeetingInFolder,
    async (_event, rawMeeting: unknown, rawFolder: unknown, inFolder: unknown) => {
      const meetingId = parseMeetingId(rawMeeting);
      const folderId = parseFolderId(rawFolder);
      if (!meetingId || !folderId || typeof inFolder !== "boolean") return;
      await saving("folder assign", "Could not change this meeting's folders. Try again.", () =>
        meetings.setInFolder(meetingId, folderId, inFolder),
      );
    },
  );
  hubCommands.handle(Channel.searchMeetings, (_event, query: unknown) =>
    typeof query === "string" ? meetings.search(query) : [],
  );
  hubCommands.handle(Channel.updateMeetingsSettings, async (_event, raw: unknown) => {
    const patch = parseMeetingsSettingsPatch(raw);
    await saving("settings", "Could not save the meeting settings. Try again.", () =>
      meetings.updateSettings(patch),
    );
  });
  hubCommands.handle(Channel.copyMeetingMarkdown, async (_event, raw: unknown) => {
    const id = parseMeetingId(raw);
    if (!id) return;
    clipboard.writeText((await markdownOf(id)).markdown);
  });
  hubCommands.handle(Channel.exportMeetingMarkdown, async (event, raw: unknown) => {
    const id = parseMeetingId(raw);
    if (!id) return "cancelled";
    const { meeting, markdown } = await markdownOf(id);
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = {
      defaultPath: `${titleText(meeting).replace(UNSAFE_FILE_NAME, "-")}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    };
    const { canceled, filePath } = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (canceled || !filePath) return "cancelled";
    await saving("export", "Could not save the file. Try another place.", () =>
      writeFile(filePath, markdown),
    );
    return "saved";
  });
  hubCommands.handle(Channel.retryMeetingTranscript, withMeeting(recorder.retryFinalPass));
  hubCommands.handle(Channel.deleteMeetingAudio, withMeeting(recorder.deleteAudio));
  hubCommands.handle(Channel.startMeeting, () => recorder.start());
  hubCommands.handle(Channel.toggleMeeting, () => recorder.toggle());
  hubCommands.handle(Channel.generateMeetingSummary, withMeeting(recorder.generateSummary));
  hubCommands.handle(Channel.openNotepad, () => deps.openNotepad());
  hubCommands.handle(Channel.dismissMeetingNotice, (_event, key: unknown) => {
    if (typeof key !== "number") return;
    deps.store.update((s) => ({ ...s, meeting: dismissBanner(s.meeting, key) }));
  });
}

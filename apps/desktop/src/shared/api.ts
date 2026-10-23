import type { BundleId } from "./app-categories.ts";
import type { Microphone } from "./microphone.ts";
import type { DictationLanguage } from "./dictation-language.ts";
import type { ModelId } from "./models.ts";
import type { DictionaryEntry } from "./dictionary.ts";
import type { HistoryRetention, HistoryState } from "./history.ts";
import type { Insights } from "./insights.ts";
import type { SettingsPatch } from "./settings-patch.ts";
import type { Snippet } from "./snippets.ts";
import { DEFAULT_TRANSFORMS, type LastTransform, type TransformSettings } from "./transforms.ts";
import {
  DEFAULT_STYLES,
  type Assignment,
  type AssignmentEdit,
  type CategoryStyles,
} from "./style.ts";

export type PermissionKind = "microphone" | "accessibility";
export type PermissionState = "granted" | "denied" | "notDetermined";
export const hotkeys = ["fn", "rightOption", "rightCommand"] as const;
export type Hotkey = (typeof hotkeys)[number];
export const UPDATE_CHANNELS = ["stable", "nightly"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const MIN_PAGE_ANIMATION_MS = 0;
export const MAX_PAGE_ANIMATION_MS = 400;
export const PAGE_ANIMATION_STEP_MS = 25;
export const CONSENTS = ["on", "off"] as const;
export type DiagnosticsConsent = (typeof CONSENTS)[number];
// "unavailable" is a development build, which never registers a login item.
export type LoginItem = "on" | "off" | "needsApproval" | "unavailable";
export const DIAGNOSTICS_ARGUMENT = "--voice-diagnostics";

export type ReleaseNotes = {
  releases: readonly { version: string; items: readonly string[] }[];
  more: boolean;
};

export type UpdateStatus =
  | { kind: "disabled"; reason: string }
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; version: string; notes: ReleaseNotes }
  | { kind: "downloading"; version: string; notes: ReleaseNotes; percent: number }
  | { kind: "ready"; version: string; notes: ReleaseNotes }
  | { kind: "installing"; version: string }
  | { kind: "failed"; message: string };

/** An update the user can read about before installing it. */
export type PendingUpdate = Extract<UpdateStatus, { kind: "available" | "downloading" | "ready" }>;

export function pendingUpdate(status: UpdateStatus): PendingUpdate | null {
  return status.kind === "available" || status.kind === "downloading" || status.kind === "ready"
    ? status
    : null;
}

export type UpdatesSnapshot = {
  version: string;
  installedChannel: UpdateChannel;
  channel: UpdateChannel;
  status: UpdateStatus;
};

/**
 * The URL scheme the browser uses to hand a sign-in back to Voice (RFC 8252 section 7.1).
 * Fixed reverse-DNS, not derived from the app id, because the project does not own voice.app.
 * `electron-builder.yml` repeats it under `protocols`; a test keeps the two in step.
 */
export const VOICE_URL_SCHEME = "com.codlume.voice";

/**
 * The account is the signed-in credential ("auth session"), never a dictation session.
 * `unavailable` is a build with no API URL for its channel, like the `disabled` update status.
 */
export type AccountState =
  | { kind: "unavailable"; reason: string }
  | { kind: "signedOut" }
  | { kind: "signingIn"; purpose: "signIn" | "deleteAccount"; phase: "browser" | "finishing" }
  | ({ kind: "signedIn"; deletion?: AccountDeletion; notice?: string } & AccountIdentity)
  | { kind: "error"; message: string };

export type AccountIdentity = {
  id?: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  image?: string;
};

export type AccountName = Pick<AccountIdentity, "firstName" | "lastName">;

export const fullName = ({ firstName, lastName }: AccountName) =>
  [firstName, lastName].filter(Boolean).join(" ");

export const ACCOUNT_NAME_MAX_LENGTH = 100;

export type AccountDeletion =
  | { kind: "confirming" }
  | { kind: "deleting" }
  | { kind: "reauthRequired" | "reauthFailed"; message: string }
  | { kind: "revoking" }
  | { kind: "revocationFailed"; message: string }
  | { kind: "failed"; message: string };

export type InsertMethod = "accessibility" | "paste" | "none";
/** `selectionChanged`: the selection moved or the user typed between a transform's read and its write. */
export type InsertFailure =
  | "focusChanged"
  | "noFocusedField"
  | "secureInput"
  | "selectionChanged"
  | "failed";

type Inserted = { kind: "inserted"; method: Exclude<InsertMethod, "none"> };
type NotInserted = { kind: "notInserted"; reason: InsertFailure };

export type Outcome =
  | Inserted
  | NotInserted
  | { kind: "empty" }
  | { kind: "tooShort" }
  | { kind: "failed"; message: string };

export type SelectionFailure =
  | "noSelection"
  | "secureInput"
  | "noFocusedField"
  | "keysHeld"
  | "failed";

/** Never carries text. `failed.message` is one of a fixed set of sentences, never model output. */
export type TransformOutcome =
  | Inserted
  | NotInserted
  | { kind: Exclude<SelectionFailure, "failed"> | "cancelled" }
  | { kind: "tooLong"; maxWords: number }
  | { kind: "modelUnavailable"; state: "missing" | "failed" }
  | { kind: "modelUnavailable"; state: "downloading"; progress?: number }
  | { kind: "failed"; message: string };

export type PillState =
  | { kind: "idle" }
  | { kind: "listening" }
  | { kind: "processing"; overdue: boolean }
  | { kind: "done"; outcome: Outcome }
  | { kind: "transforming"; loading: boolean }
  | { kind: "transformDone"; outcome: TransformOutcome };

export type ModelStatus =
  | { state: "missing" }
  | { state: "downloading"; progress?: number }
  | { state: "loading" }
  | { state: "ready" }
  | { state: "installed" }
  | { state: "failed"; message: string };

export type { Microphone } from "./microphone.ts";
export type MicrophoneCatalog =
  | { kind: "loading" }
  | { kind: "ready"; devices: readonly Microphone[]; defaultUid: string | null }
  | { kind: "unavailable"; message: string };

export type MicrophoneTest =
  | { kind: "off" }
  | { kind: "starting" }
  // The helper restarts a test when its device changes. Each restart is a new episode, so the
  // renderer can reset what it heard.
  | { kind: "listening"; episode: number }
  | { kind: "failed"; message: string };

export type Settings = {
  microphone: Microphone | null;
  hotkey: Hotkey;
  /** Tap once to start, tap again to stop. Never equal to `hotkey`. */
  toggleHotkey: Hotkey | null;
  muteWhileDictating: boolean;
  copyToClipboard: boolean;
  showInDock: boolean;
  alwaysShowPill: boolean;
  dictationLanguage: DictationLanguage;
  updateChannel: UpdateChannel;
  theme: Theme;
  pageAnimationMs: number;
  cleanup: {
    enabled: boolean;
    styles: CategoryStyles;
    assignments: readonly Assignment[];
  };
  diagnostics: DiagnosticsConsent;
  snippets: readonly Snippet[];
  dictionary: readonly DictionaryEntry[];
  /** Chromium zoom level of the Voice window. The Flow Bar never zooms. */
  zoomLevel: number;
  transforms: TransformSettings;
};

export const DEFAULT_SETTINGS: Settings = {
  microphone: null,
  hotkey: "fn",
  toggleHotkey: null,
  muteWhileDictating: false,
  copyToClipboard: false,
  showInDock: true,
  alwaysShowPill: true,
  dictationLanguage: "en",
  updateChannel: "stable",
  theme: "system",
  pageAnimationMs: 200,
  cleanup: { enabled: true, styles: DEFAULT_STYLES, assignments: [] },
  diagnostics: "off",
  snippets: [],
  dictionary: [],
  zoomLevel: 0,
  transforms: DEFAULT_TRANSFORMS,
};

export type { SettingsPatch } from "./settings-patch.ts";

export type Snapshot = {
  microphones: MicrophoneCatalog;
  microphoneTest: MicrophoneTest;
  updates: UpdatesSnapshot;
  session: PillState;
  permissions: Record<PermissionKind, PermissionState>;
  loginItem: LoginItem;
  models: Record<ModelId, ModelStatus>;
  settings: Settings;
  account: AccountState;
};

export type PillSnapshot = Pick<Snapshot, "session"> &
  Pick<Settings, "alwaysShowPill" | "copyToClipboard">;

export function toPillSnapshot({ session, settings }: Snapshot): PillSnapshot {
  return {
    session,
    alwaysShowPill: settings.alwaysShowPill,
    copyToClipboard: settings.copyToClipboard,
  };
}

export type RestartChoice = "restart" | "copyTranscriptAndRestart";
/**
 * `latest` is the id of the newest history entry the user saw when they chose, so main can refuse
 * if a newer transcript arrived.
 */
export type RestartRequest = { choice: RestartChoice; latest: string | null };

export type TranscriptVersion = "text" | "raw";

export const parseTranscriptVersion = (value: unknown): TranscriptVersion | null =>
  value === "text" || value === "raw" ? value : null;

type WindowApi = {
  diagnosticsStartedAtLaunch: boolean;
  onLevel(listener: (level: number) => void): () => void;
};

export type PillApi = WindowApi & {
  getPillSnapshot(): Promise<PillSnapshot>;
  onPillSnapshot(listener: (snapshot: PillSnapshot) => void): () => void;
};

/** An app found in the standard application folders. `browser` marks the apps the helper reads a page host from. */
export type InstalledApp = { bundleId: BundleId; name: string; browser: boolean };

/** PNG data URLs by bundle id. */
export type AppIcons = Partial<Record<BundleId, string>>;

export type HubApi = WindowApi & {
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  restartForUpdate(request: RestartRequest): Promise<void>;
  /** The tray asks the hub to confirm a restart. A request made before anyone listens is kept. */
  onRestartRequest(listener: () => void): () => void;
  openRelease(): Promise<void>;
  getSnapshot(): Promise<Snapshot>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
  updateSettings(patch: SettingsPatch): Promise<void>;
  requestPermission(kind: PermissionKind): Promise<void>;
  setOpenAtLogin(on: boolean): Promise<void>;
  startMicrophoneTest(): Promise<void>;
  stopMicrophoneTest(): Promise<void>;
  installModel(id: ModelId): Promise<void>;
  uninstallModel(id: ModelId): Promise<void>;
  getHistory(): Promise<HistoryState>;
  /** Fires after every change to the history, with the whole list, newest first. */
  onHistory(listener: (history: HistoryState) => void): () => void;
  copyHistoryEntry(id: string, version: TranscriptVersion): Promise<void>;
  deleteHistoryEntry(id: string): Promise<void>;
  clearHistory(): Promise<void>;
  /** Rejects with a message for the user when the file could not be written or deleted. */
  setHistoryRetention(retention: HistoryRetention): Promise<void>;
  /** Opens the system browser on the API. Resolves once the browser is open, not once signed in. */
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** The code the landing page shows, for a build that cannot receive the URL scheme. */
  submitSignInCode(code: string): Promise<void>;
  cancelSignIn(): Promise<void>;
  dismissAccountError(): Promise<void>;
  /** Rejects with a message for the user when the name was not saved. */
  updateAccountName(name: AccountName): Promise<void>;
  requestAccountDeletion(): Promise<void>;
  confirmAccountDeletion(): Promise<void>;
  cancelAccountDeletion(): Promise<void>;
  retryAccountDeletion(): Promise<void>;
  getInsights(): Promise<Insights>;
  /** Fires after each counted session and after a clear, with the whole value. */
  onInsights(listener: (insights: Insights) => void): () => void;
  /** Rejects with a message for the user when the file could not be removed. */
  clearInsights(): Promise<void>;
  /** Rejects when the helper does not answer in time. */
  getInstalledApps(): Promise<InstalledApp[]>;
  /** Icons of apps from the last installed-app list. Leaves out any it could not render. */
  getAppIcons(bundleIds: readonly BundleId[]): Promise<AppIcons>;
  /** Applies one assignment change to the saved settings. Rejects with a message for the user when the save failed. */
  editAssignments(edit: AssignmentEdit): Promise<void>;
  getLastTransform(): Promise<LastTransform | null>;
  /** Fires after every change, with the whole value; null once Transforms are turned off. */
  onLastTransform(listener: (value: LastTransform | null) => void): () => void;
  /** Copies in main, so the text never round-trips through the renderer. */
  copyLastTransform(which: "before" | "after"): Promise<void>;
};

export type VoiceApi = PillApi | HubApi;

export const Channel = {
  checkForUpdates: "voice:checkForUpdates",
  downloadUpdate: "voice:downloadUpdate",
  restartForUpdate: "voice:restartForUpdate",
  requestRestart: "voice:requestRestart",
  openRelease: "voice:openRelease",
  getSnapshot: "voice:getSnapshot",
  snapshot: "voice:snapshot",
  getPillSnapshot: "voice:getPillSnapshot",
  pillSnapshot: "voice:pillSnapshot",
  level: "voice:level",
  updateSettings: "voice:updateSettings",
  requestPermission: "voice:requestPermission",
  setOpenAtLogin: "voice:setOpenAtLogin",
  startMicrophoneTest: "voice:startMicrophoneTest",
  stopMicrophoneTest: "voice:stopMicrophoneTest",
  installModel: "voice:installModel",
  uninstallModel: "voice:uninstallModel",
  getHistory: "voice:getHistory",
  history: "voice:history",
  copyHistoryEntry: "voice:copyHistoryEntry",
  deleteHistoryEntry: "voice:deleteHistoryEntry",
  clearHistory: "voice:clearHistory",
  setHistoryRetention: "voice:setHistoryRetention",
  signIn: "voice:signIn",
  signOut: "voice:signOut",
  submitSignInCode: "voice:submitSignInCode",
  cancelSignIn: "voice:cancelSignIn",
  dismissAccountError: "voice:dismissAccountError",
  updateAccountName: "voice:updateAccountName",
  requestAccountDeletion: "voice:requestAccountDeletion",
  confirmAccountDeletion: "voice:confirmAccountDeletion",
  cancelAccountDeletion: "voice:cancelAccountDeletion",
  retryAccountDeletion: "voice:retryAccountDeletion",
  getInsights: "voice:getInsights",
  insights: "voice:insights",
  clearInsights: "voice:clearInsights",
  getInstalledApps: "voice:getInstalledApps",
  getAppIcons: "voice:getAppIcons",
  editAssignments: "voice:editAssignments",
  getLastTransform: "voice:getLastTransform",
  lastTransform: "voice:lastTransform",
  copyLastTransform: "voice:copyLastTransform",
} as const;

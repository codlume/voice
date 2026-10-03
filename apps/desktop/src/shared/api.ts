import type { Microphone } from "./microphone.ts";
import type { DictationLanguage } from "./dictation-language.ts";
import type { ModelId } from "./models.ts";

export type PermissionKind = "microphone" | "accessibility";
export type PermissionState = "granted" | "denied" | "notDetermined";
export const hotkeys = ["fn", "rightOption", "rightCommand"] as const;
export type Hotkey = (typeof hotkeys)[number];
export type UpdateChannel = "stable" | "nightly";
export type Theme = "system" | "light" | "dark";
export type DiagnosticsConsent = "on" | "off";
// "unavailable" is a development build, which never registers a login item.
export type LoginItem = "on" | "off" | "needsApproval" | "unavailable";
export const DIAGNOSTICS_ARGUMENT = "--voice-diagnostics";

export type UpdateStatus =
  | { kind: "disabled"; reason: string }
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; version: string; notes: readonly string[] }
  | { kind: "downloading"; version: string; notes: readonly string[]; percent: number }
  | { kind: "ready"; version: string; notes: readonly string[] }
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
  | {
      kind: "signedIn";
      id?: string;
      name: string;
      email: string;
      deletion?: AccountDeletion;
      notice?: string;
    }
  | { kind: "error"; message: string };

export type AccountDeletion =
  | { kind: "confirming" }
  | { kind: "deleting" }
  | { kind: "reauthRequired" | "reauthFailed"; message: string }
  | { kind: "revoking" }
  | { kind: "revocationFailed"; message: string }
  | { kind: "failed"; message: string };

export type Outcome =
  | { kind: "inserted"; method: "accessibility" | "paste" }
  | { kind: "notInserted"; reason: "focusChanged" | "noFocusedField" | "secureInput" | "failed" }
  | { kind: "empty" }
  | { kind: "tooShort" }
  | { kind: "failed"; message: string };

export type PillState =
  | { kind: "idle" }
  | { kind: "listening" }
  | { kind: "processing" }
  | { kind: "done"; outcome: Outcome };

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
  muteWhileDictating: boolean;
  showInDock: boolean;
  alwaysShowPill: boolean;
  dictationLanguage: DictationLanguage;
  updateChannel: UpdateChannel;
  theme: Theme;
  cleanup: {
    enabled: boolean;
    styling: "casual" | "semi-casual" | "semi-formal" | "formal";
  };
  diagnostics: DiagnosticsConsent;
};

export type SettingsPatch = {
  microphone?: Microphone | null;
  hotkey?: Hotkey;
  muteWhileDictating?: boolean;
  showInDock?: boolean;
  alwaysShowPill?: boolean;
  dictationLanguage?: DictationLanguage;
  updateChannel?: UpdateChannel;
  theme?: Theme;
  cleanup?: Partial<Settings["cleanup"]>;
  diagnostics?: DiagnosticsConsent;
};

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
  /** The other channel's storage prefix holds an auth session, read once at launch. */
  otherChannelSignedIn: boolean;
  last: { raw: string; text: string } | null;
};

export type RestartChoice = "restart" | "copyTranscriptAndRestart";
/** `last` is the transcript the user saw when they chose, so main can refuse if a newer one arrived. */
export type RestartRequest = { choice: RestartChoice; last: Snapshot["last"] };

export function sameTranscript(a: Snapshot["last"], b: Snapshot["last"]): boolean {
  return a?.raw === b?.raw && a?.text === b?.text;
}

export type VoiceApi = {
  diagnosticsStartedAtLaunch: boolean;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  restartForUpdate(request: RestartRequest): Promise<void>;
  /** The tray asks the hub to confirm a restart. A request made before anyone listens is kept. */
  onRestartRequest(listener: () => void): () => void;
  openRelease(): Promise<void>;
  getSnapshot(): Promise<Snapshot>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
  onLevel(listener: (level: number) => void): () => void;
  updateSettings(patch: SettingsPatch): Promise<void>;
  requestPermission(kind: PermissionKind): Promise<void>;
  setOpenAtLogin(on: boolean): Promise<void>;
  startMicrophoneTest(): Promise<void>;
  stopMicrophoneTest(): Promise<void>;
  installModel(id: ModelId): Promise<void>;
  uninstallModel(id: ModelId): Promise<void>;
  copyLast(which: "text" | "raw"): Promise<void>;
  /** Opens the system browser on the API. Resolves once the browser is open, not once signed in. */
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** The code the landing page shows, for a build that cannot receive the URL scheme. */
  submitSignInCode(code: string): Promise<void>;
  cancelSignIn(): Promise<void>;
  dismissAccountError(): Promise<void>;
  requestAccountDeletion(): Promise<void>;
  confirmAccountDeletion(): Promise<void>;
  cancelAccountDeletion(): Promise<void>;
  retryAccountDeletion(): Promise<void>;
};

export const Channel = {
  checkForUpdates: "voice:checkForUpdates",
  downloadUpdate: "voice:downloadUpdate",
  restartForUpdate: "voice:restartForUpdate",
  requestRestart: "voice:requestRestart",
  openRelease: "voice:openRelease",
  getSnapshot: "voice:getSnapshot",
  snapshot: "voice:snapshot",
  level: "voice:level",
  updateSettings: "voice:updateSettings",
  requestPermission: "voice:requestPermission",
  setOpenAtLogin: "voice:setOpenAtLogin",
  startMicrophoneTest: "voice:startMicrophoneTest",
  stopMicrophoneTest: "voice:stopMicrophoneTest",
  installModel: "voice:installModel",
  uninstallModel: "voice:uninstallModel",
  copyLast: "voice:copyLast",
  signIn: "voice:signIn",
  signOut: "voice:signOut",
  submitSignInCode: "voice:submitSignInCode",
  cancelSignIn: "voice:cancelSignIn",
  dismissAccountError: "voice:dismissAccountError",
  requestAccountDeletion: "voice:requestAccountDeletion",
  confirmAccountDeletion: "voice:confirmAccountDeletion",
  cancelAccountDeletion: "voice:cancelAccountDeletion",
  retryAccountDeletion: "voice:retryAccountDeletion",
} as const;

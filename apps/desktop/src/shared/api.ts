import type { Microphone } from "./microphone.ts";
import type { DictationLanguage } from "./dictation-language.ts";

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
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string }
  | { kind: "installing"; version: string }
  | { kind: "failed"; message: string };

export type UpdatesSnapshot = {
  version: string;
  installedChannel: UpdateChannel;
  channel: UpdateChannel;
  status: UpdateStatus;
};

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
  models: { asr: ModelStatus; cleanup: ModelStatus };
  settings: Settings;
  last: { raw: string; text: string } | null;
};

export type VoiceApi = {
  diagnosticsStartedAtLaunch: boolean;
  checkForUpdates(): Promise<void>;
  restartForUpdate(): Promise<void>;
  getSnapshot(): Promise<Snapshot>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
  onLevel(listener: (level: number) => void): () => void;
  updateSettings(patch: SettingsPatch): Promise<void>;
  requestPermission(kind: PermissionKind): Promise<void>;
  setOpenAtLogin(on: boolean): Promise<void>;
  startMicrophoneTest(): Promise<void>;
  stopMicrophoneTest(): Promise<void>;
  setupModels(): Promise<void>;
  copyLast(which: "text" | "raw"): Promise<void>;
};

export const Channel = {
  checkForUpdates: "voice:checkForUpdates",
  restartForUpdate: "voice:restartForUpdate",
  getSnapshot: "voice:getSnapshot",
  snapshot: "voice:snapshot",
  level: "voice:level",
  updateSettings: "voice:updateSettings",
  requestPermission: "voice:requestPermission",
  setOpenAtLogin: "voice:setOpenAtLogin",
  startMicrophoneTest: "voice:startMicrophoneTest",
  stopMicrophoneTest: "voice:stopMicrophoneTest",
  setupModels: "voice:setupModels",
  copyLast: "voice:copyLast",
} as const;

export type PermissionKind = "microphone" | "accessibility";
export type PermissionState = "granted" | "denied" | "notDetermined";
export type Hotkey = "fn" | "rightOption" | "rightCommand";

export type Outcome =
  | { kind: "inserted"; method: "accessibility" | "paste" }
  | { kind: "notInserted"; reason: "focusChanged" | "noFocusedField" | "secureInput" | "failed" }
  | { kind: "empty" }
  | { kind: "tooShort" }
  | { kind: "cancelled" }
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

export type Settings = {
  hotkey: Hotkey;
  cleanup: {
    enabled: boolean;
    styling: "casual" | "semi-casual" | "semi-formal" | "formal";
    structure: "prose" | "lists";
    context: "general" | "email";
  };
};

export type SettingsPatch = {
  hotkey?: Hotkey;
  cleanup?: Partial<Settings["cleanup"]>;
};

export type Snapshot = {
  session: PillState;
  permissions: Record<PermissionKind, PermissionState>;
  models: { asr: ModelStatus; cleanup: ModelStatus };
  settings: Settings;
  last: { raw: string; text: string } | null;
};

export type VoiceApi = {
  getSnapshot(): Promise<Snapshot>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
  /** 0..1 microphone level, ~30 Hz while recording. */
  onLevel(listener: (level: number) => void): () => void;
  updateSettings(patch: SettingsPatch): Promise<void>;
  requestPermission(kind: PermissionKind): Promise<void>;
  setupModels(): Promise<void>;
  copyLast(which: "text" | "raw"): Promise<void>;
};

export const Channel = {
  getSnapshot: "voice:getSnapshot",
  snapshot: "voice:snapshot",
  level: "voice:level",
  updateSettings: "voice:updateSettings",
  requestPermission: "voice:requestPermission",
  setupModels: "voice:setupModels",
  copyLast: "voice:copyLast",
} as const;

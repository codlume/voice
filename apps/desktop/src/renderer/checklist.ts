import type {
  Hotkey,
  ModelStatus,
  PermissionKind,
  PermissionState,
  Snapshot,
} from "../shared/api.ts";

import { wantsCleanup } from "../shared/dictation-language.ts";

export type SetupCommand =
  | { type: "requestPermission"; kind: PermissionKind }
  | { type: "setupModels" };

type Control =
  | { kind: "button"; label: "Download" | "Retry"; command: SetupCommand }
  | { kind: "switch"; checked: true }
  | { kind: "switch"; checked: false; command: SetupCommand };

export type ChecklistRow = {
  id: PermissionKind | "asr" | "cleanup";
  title: string;
  subtitle: string;
  status:
    | { kind: "ready"; text: string }
    | { kind: "needed"; text: string }
    | { kind: "busy"; text: string; progress?: number }
    | { kind: "failed"; text: string };
  control: Control | null;
};

type Checklist = { ready: boolean; rows: ChecklistRow[] };

export const hotkeyLabels: Record<Hotkey, string> = {
  fn: "fn",
  rightOption: "Right Option",
  rightCommand: "Right Command",
};

type RowState = Pick<ChecklistRow, "status" | "control">;

function permissionState(kind: PermissionKind, state: PermissionState): RowState {
  const command: SetupCommand = { type: "requestPermission", kind };
  switch (state) {
    case "granted":
      return {
        status: { kind: "ready", text: "Granted" },
        control: { kind: "switch", checked: true },
      };
    case "notDetermined":
      return {
        status: { kind: "needed", text: "Needs access" },
        control: { kind: "switch", checked: false, command },
      };
    case "denied":
      return {
        status: { kind: "needed", text: "Allow Voice in System Settings" },
        control: { kind: "switch", checked: false, command },
      };
  }
}

function modelState(model: ModelStatus): RowState {
  const command: SetupCommand = { type: "setupModels" };
  switch (model.state) {
    case "ready":
      return { status: { kind: "ready", text: "Ready" }, control: null };
    case "missing":
      return {
        status: { kind: "needed", text: "Not downloaded" },
        control: { kind: "button", label: "Download", command },
      };
    case "downloading":
      return model.progress === undefined
        ? { status: { kind: "busy", text: "Downloading" }, control: null }
        : {
            status: {
              kind: "busy",
              text: `Downloading ${Math.round(model.progress * 100)}%`,
              progress: model.progress,
            },
            control: null,
          };
    case "loading":
      return { status: { kind: "busy", text: "Loading" }, control: null };
    case "failed":
      return {
        status: { kind: "failed", text: model.message },
        control: { kind: "button", label: "Retry", command },
      };
  }
}

export function checklist({ permissions, models, settings }: Snapshot): Checklist {
  const rows: ChecklistRow[] = [
    {
      id: "microphone",
      title: "Microphone",
      subtitle: "Hears you only while you hold the key",
      ...permissionState("microphone", permissions.microphone),
    },
    {
      id: "accessibility",
      title: "Accessibility",
      subtitle: "Types the text into the app you are using",
      ...permissionState("accessibility", permissions.accessibility),
    },
    {
      id: "asr",
      title: "Speech model",
      subtitle: "Parakeet, on this Mac",
      ...modelState(models.asr),
    },
  ];
  if (wantsCleanup(settings)) {
    rows.push({
      id: "cleanup",
      title: "Cleanup model",
      subtitle: "S1-mini by Superwhisper",
      ...modelState(models.cleanup),
    });
  }
  return { ready: rows.every((row) => row.status.kind === "ready"), rows };
}

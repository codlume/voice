import type {
  Hotkey,
  ModelStatus,
  PermissionKind,
  PermissionState,
  Settings,
  Snapshot,
} from "../shared/api.ts";

import { wantsCleanup } from "../shared/dictation-language.ts";

export type SetupCommand =
  | { type: "requestPermission"; kind: PermissionKind }
  | { type: "setupModels" };

export type ChecklistRow = {
  id: PermissionKind | "asr" | "cleanup";
  title: string;
  subtitle: string;
  status:
    | { kind: "ready"; text: string }
    | { kind: "needed"; text: string }
    | { kind: "busy"; text: string; progress?: number }
    | { kind: "failed"; text: string };
  action?: { label: "Grant" | "Open" | "Download" | "Retry"; command: SetupCommand };
};

type Checklist = { ready: boolean; rows: ChecklistRow[] };

export const hotkeyLabels: Record<Hotkey, string> = {
  fn: "fn",
  rightOption: "Right Option",
  rightCommand: "Right Command",
};

type RowState = Pick<ChecklistRow, "status" | "action">;

function permissionState(kind: PermissionKind, state: PermissionState): RowState {
  const command: SetupCommand = { type: "requestPermission", kind };
  switch (state) {
    case "granted":
      return { status: { kind: "ready", text: "Granted" } };
    case "notDetermined":
      return {
        status: { kind: "needed", text: "Needs access" },
        action: { label: "Grant", command },
      };
    case "denied":
      return {
        status: { kind: "needed", text: "Allow Voice in System Settings" },
        action: { label: "Open", command },
      };
  }
}

function modelState(model: ModelStatus): RowState {
  const command: SetupCommand = { type: "setupModels" };
  switch (model.state) {
    case "ready":
      return { status: { kind: "ready", text: "Ready" } };
    case "missing":
      return {
        status: { kind: "needed", text: "Not downloaded" },
        action: { label: "Download", command },
      };
    case "downloading":
      return model.progress === undefined
        ? { status: { kind: "busy", text: "Downloading" } }
        : {
            status: {
              kind: "busy",
              text: `Downloading ${Math.round(model.progress * 100)}%`,
              progress: model.progress,
            },
          };
    case "loading":
      return { status: { kind: "busy", text: "Loading" } };
    case "failed":
      return {
        status: { kind: "failed", text: model.message },
        action: { label: "Retry", command },
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

type Styling = Settings["cleanup"]["styling"];

export const stylings: { value: Styling; label: string; example: string }[] = [
  { value: "casual", label: "Casual", example: "yeah sounds good, see you at 3" },
  { value: "semi-casual", label: "Semi-casual", example: "Yeah, sounds good. See you at 3." },
  { value: "semi-formal", label: "Semi-formal", example: "Sounds good. I'll see you at 3." },
  { value: "formal", label: "Formal", example: "That sounds good. I will see you at 3:00." },
];

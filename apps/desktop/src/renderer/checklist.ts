import type {
  Hotkey,
  ModelStatus,
  PermissionKind,
  PermissionState,
  Snapshot,
} from "../shared/api.ts";

import { wantsCleanup } from "../shared/dictation-language.ts";
import { models, type ModelId } from "../shared/models.ts";

export type SetupCommand =
  | { type: "requestPermission"; kind: PermissionKind }
  | { type: "installModel"; id: ModelId };

type Action = {
  label: "Grant" | "Open" | "Download" | "Retry";
  command: SetupCommand;
};

export type ChecklistRow = {
  id: PermissionKind | ModelId;
  title: string;
  subtitle: string;
  status:
    | { kind: "ready"; text: string }
    | { kind: "needed"; text: string }
    | { kind: "busy"; text: string; progress?: number }
    | { kind: "failed"; text: string };
  actions: readonly Action[];
};

type Checklist = { ready: boolean; rows: ChecklistRow[] };

export const hotkeyLabels: Record<Hotkey, string> = {
  fn: "fn",
  rightOption: "Right Option",
  rightCommand: "Right Command",
};

type RowState = Pick<ChecklistRow, "status" | "actions">;

function permissionState(kind: PermissionKind, state: PermissionState): RowState {
  const command: SetupCommand = { type: "requestPermission", kind };
  switch (state) {
    case "granted":
      return { status: { kind: "ready", text: "Granted" }, actions: [] };
    case "notDetermined":
      return {
        status: { kind: "needed", text: "Needs access" },
        actions: [{ label: "Grant", command }],
      };
    case "denied":
      return {
        status: { kind: "needed", text: "Allow Voice in System Settings" },
        actions: [{ label: "Open", command }],
      };
  }
}

function modelState(id: ModelId, model: ModelStatus): RowState {
  const command: SetupCommand = { type: "installModel", id };
  switch (model.state) {
    case "ready":
      return { status: { kind: "ready", text: "Ready" }, actions: [] };
    case "installed":
      return { status: { kind: "ready", text: "Downloaded" }, actions: [] };
    case "missing":
      return {
        status: { kind: "needed", text: "Not downloaded" },
        actions: [{ label: "Download", command }],
      };
    case "downloading":
      return model.progress === undefined
        ? { status: { kind: "busy", text: "Downloading" }, actions: [] }
        : {
            status: {
              kind: "busy",
              text: `Downloading ${Math.round(model.progress * 100)}%`,
              progress: model.progress,
            },
            actions: [],
          };
    case "loading":
      return { status: { kind: "busy", text: "Loading" }, actions: [] };
    case "failed":
      return {
        status: { kind: "failed", text: model.message },
        actions: [{ label: "Retry", command }],
      };
  }
}

export function checklist({ permissions, models: statuses, settings }: Snapshot): Checklist {
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
  ];
  for (const model of models) {
    if (model.id === "cleanup" && !wantsCleanup(settings)) continue;
    rows.push({
      id: model.id,
      title: model.kind,
      subtitle: `${model.name} by ${model.vendor}`,
      ...modelState(model.id, statuses[model.id]),
    });
  }
  return { ready: rows.every((row) => row.status.kind === "ready"), rows };
}

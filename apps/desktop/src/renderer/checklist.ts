import type {
  ModelStatus,
  PermissionKind,
  PermissionState,
  Snapshot,
  SpeakerModelState,
  SystemAudioPermission,
} from "../shared/api.ts";

import { modelById, models, type Model, type ModelId } from "../shared/models.ts";
import { PREPARING_TEXT } from "./modelView.ts";

export type SetupCommand =
  | { type: "requestPermission"; kind: PermissionKind }
  | { type: "installModel"; id: ModelId }
  | { type: "uninstallModel"; id: ModelId }
  | { type: "downloadSpeakerModel" };

type Action = {
  label: "Grant" | "Open" | "Download" | "Retry" | "Cancel";
  command: SetupCommand;
};

export type ChecklistRow = {
  id: PermissionKind | ModelId | "speakerModel" | "tryMeetings";
  title: string;
  subtitle: string;
  status:
    | { kind: "ready"; text: string }
    | { kind: "needed"; text: string }
    | { kind: "busy"; text: string; progress?: number }
    | { kind: "failed"; text: string }
    /** Nothing the user can do on this Mac; it does not hold the checklist open. */
    | { kind: "unavailable"; text: string };
  actions: readonly Action[];
};

type Checklist = { ready: boolean; rows: ChecklistRow[] };

export const settled = (row: ChecklistRow) =>
  row.status.kind === "ready" || row.status.kind === "unavailable";

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

function modelState(model: Model, status: ModelStatus): RowState {
  const command: SetupCommand = { type: "installModel", id: model.id };
  switch (status.state) {
    case "ready":
      return { status: { kind: "ready", text: "Ready" }, actions: [] };
    case "installed":
      return { status: { kind: "ready", text: "Downloaded" }, actions: [] };
    case "missing":
      return {
        status: { kind: "needed", text: "Not downloaded" },
        actions: [{ label: "Download", command }],
      };
    case "downloading": {
      const actions: Action[] = model.cancelableDownload
        ? [{ label: "Cancel", command: { type: "uninstallModel", id: model.id } }]
        : [];
      return status.progress === undefined
        ? { status: { kind: "busy", text: "Downloading" }, actions }
        : {
            status: {
              kind: "busy",
              text: `Downloading ${Math.round(status.progress * 100)}%`,
              progress: status.progress,
            },
            actions,
          };
    }
    case "loading":
      return { status: { kind: "busy", text: "Loading" }, actions: [] };
    case "failed":
      return {
        status: { kind: "failed", text: status.message },
        actions: [{ label: "Retry", command }],
      };
  }
}

const preparing = (status: ModelStatus) =>
  status.state === "loading" && status.preparing ? PREPARING_TEXT : undefined;

export function checklist({ permissions, models: statuses, settings }: Snapshot): Checklist {
  const rows: ChecklistRow[] = [
    {
      id: "microphone",
      title: "Microphone",
      subtitle: "Hears you only while you dictate or record a meeting",
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
    if (!model.wanted(settings)) continue;
    rows.push({
      id: model.id,
      title: model.kind,
      subtitle: preparing(statuses[model.id]) ?? `${model.name} by ${model.vendor}`,
      ...modelState(model, statuses[model.id]),
    });
  }
  return { ready: rows.every((row) => row.status.kind === "ready"), rows };
}

function systemAudioState(state: SystemAudioPermission): RowState {
  if (state !== "unavailable") return permissionState("systemAudio", state);
  return { status: { kind: "unavailable", text: "Needs macOS 14.4 or later" }, actions: [] };
}

function speakerModelState(state: SpeakerModelState): RowState {
  const download: Action = { label: "Download", command: { type: "downloadSpeakerModel" } };
  switch (state) {
    case "ready":
      return { status: { kind: "ready", text: "Downloaded" }, actions: [] };
    case "missing":
      return { status: { kind: "needed", text: "Not downloaded" }, actions: [download] };
    case "downloading":
      return { status: { kind: "busy", text: "Downloading" }, actions: [] };
    case "failed":
      return {
        status: { kind: "failed", text: "Download failed" },
        actions: [{ ...download, label: "Retry" }],
      };
    case "unavailable":
      return { status: { kind: "unavailable", text: "Needs macOS 15 or later" }, actions: [] };
  }
}

/**
 * "Set up Meetings": both permissions, the speaker models, then one meeting tried. `shortcut`
 * is the meeting shortcut as the keyboard shows it, or null when it is off.
 */
export function meetingsChecklist(
  { permissions, speakerModel }: Pick<Snapshot, "permissions" | "speakerModel">,
  { tried, shortcut }: { tried: boolean; shortcut: string | null },
): Checklist {
  const rows: ChecklistRow[] = [
    {
      id: "microphone",
      title: "Microphone",
      subtitle: "Hears you during a meeting",
      ...permissionState("microphone", permissions.microphone),
    },
    {
      id: "systemAudio",
      title: "System Audio Recording",
      subtitle:
        permissions.systemAudio === "unavailable"
          ? "Meetings record only your microphone on this Mac"
          : "Hears the other participants through your Mac's sound",
      ...systemAudioState(permissions.systemAudio),
    },
    {
      id: "speakerModel",
      title: "Speaker detection",
      subtitle:
        speakerModel === "unavailable"
          ? "Others stay one voice on this Mac"
          : "Tells the other participants apart after a meeting (21 MB, on this Mac)",
      ...speakerModelState(speakerModel),
    },
    {
      id: "tryMeetings",
      title: "Try Meetings",
      subtitle: `Click Start meeting${shortcut ? ` or press ${shortcut}` : ""}, talk a little, then stop`,
      status: tried ? { kind: "ready", text: "Done" } : { kind: "needed", text: "Not yet" },
      actions: [],
    },
  ];
  return { ready: rows.every(settled), rows };
}

/** Summaries need the transform model. Null once it is on disk, since transcripts never need it. */
export function summaryModelRow({
  models: statuses,
}: Pick<Snapshot, "models">): ChecklistRow | null {
  const status = statuses.transform;
  if (status.state === "installed" || status.state === "loading" || status.state === "ready") {
    return null;
  }
  const model = modelById.transform;
  return {
    id: model.id,
    title: "Summary model",
    subtitle: `Summaries use ${model.name} by ${model.vendor} (${model.size}). Transcripts work without it.`,
    ...modelState(model, status),
  };
}

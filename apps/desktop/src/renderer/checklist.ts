import type {
  DiagnosticsConsent,
  Hotkey,
  ModelStatus,
  PermissionKind,
  PermissionState,
  Snapshot,
} from "../shared/api.ts";

import { wantsCleanup } from "../shared/dictation-language.ts";

export type SetupCommand =
  | { type: "requestPermission"; kind: PermissionKind }
  | { type: "setupModels" }
  | { type: "setDiagnostics"; consent: Exclude<DiagnosticsConsent, "unanswered"> };

type Action = {
  label: "Grant" | "Open" | "Download" | "Retry" | "Share" | "Don't share";
  command: SetupCommand;
};

export type ChecklistRow = {
  id: PermissionKind | "asr" | "cleanup" | "diagnostics";
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

function modelState(model: ModelStatus): RowState {
  const command: SetupCommand = { type: "setupModels" };
  switch (model.state) {
    case "ready":
      return { status: { kind: "ready", text: "Ready" }, actions: [] };
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

function diagnosticsState(consent: DiagnosticsConsent): RowState {
  switch (consent) {
    case "unanswered":
      return {
        status: { kind: "needed", text: "Choose" },
        actions: [
          { label: "Share", command: { type: "setDiagnostics", consent: "on" } },
          { label: "Don't share", command: { type: "setDiagnostics", consent: "off" } },
        ],
      };
    case "on":
      return { status: { kind: "ready", text: "Sharing" }, actions: [] };
    case "off":
      return { status: { kind: "ready", text: "Not sharing" }, actions: [] };
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
  rows.push({
    id: "diagnostics",
    title: "Crash reports",
    subtitle: "Crashes and timings only. Never your words or audio.",
    ...diagnosticsState(settings.diagnostics),
  });
  return { ready: rows.every((row) => row.status.kind === "ready"), rows };
}

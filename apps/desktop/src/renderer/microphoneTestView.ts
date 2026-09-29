import type { MicrophoneTest, PermissionState } from "../shared/api.ts";

// perceptualLevel puts -40 dBFS at 0.2: above room noise, below quiet speech.
export const HEARD_LEVEL = 0.2;
export const QUIET_AFTER_MS = 3000;

export type MicrophoneTestStatus = { text: string; failed: boolean };

// Null means there is nothing to report, so the test region stays closed.
export function microphoneTestStatus(
  test: MicrophoneTest,
  permission: PermissionState,
  { heard, quiet, accessRequested }: { heard: boolean; quiet: boolean; accessRequested: boolean },
): MicrophoneTestStatus | null {
  if (test.kind === "starting") return { text: "Starting microphone…", failed: false };
  if (test.kind === "listening") {
    if (heard) return { text: "Voice can hear you.", failed: false };
    if (quiet)
      return { text: "No sound yet. Speak up, or choose another microphone.", failed: false };
    return { text: "Listening. Say something.", failed: false };
  }
  if (accessRequested && permission !== "granted")
    return { text: "Voice needs microphone access to test.", failed: false };
  if (test.kind === "failed") return { text: test.message, failed: true };
  return null;
}

export type MicrophoneTestAction =
  | { kind: "stop"; label: "Stop" }
  | { kind: "requestAccess"; label: "Test" }
  | { kind: "start"; label: "Test"; disabled: boolean };

export function microphoneTestAction(
  test: MicrophoneTest,
  permission: PermissionState,
  canTest: boolean,
): MicrophoneTestAction {
  if (test.kind === "starting" || test.kind === "listening") return { kind: "stop", label: "Stop" };
  if (permission !== "granted") return { kind: "requestAccess", label: "Test" };
  return { kind: "start", label: "Test", disabled: !canTest };
}

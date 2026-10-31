import type { Settings } from "../shared/api.ts";
import { registeredShortcuts } from "../shared/transforms.ts";
import type { HelperCommand } from "./protocol.ts";

export function hotkeyConfigure(
  settings: Pick<Settings, "hotkey" | "toggleHotkey" | "transforms" | "meetingShortcut">,
  hubFocused: boolean,
): Extract<HelperCommand, { type: "hotkey.configure" }> {
  return {
    type: "hotkey.configure",
    key: settings.hotkey,
    toggleKey: settings.toggleHotkey,
    transforms: hubFocused ? [] : registeredShortcuts(settings.transforms),
    // The focused Voice window answers the meeting shortcut itself, so a shortcut picker there
    // can record the keys instead of starting a meeting.
    meeting: hubFocused ? null : settings.meetingShortcut,
  };
}

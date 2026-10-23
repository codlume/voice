import type { Settings } from "../shared/api.ts";
import { registeredShortcuts } from "../shared/transforms.ts";
import type { HelperCommand } from "./protocol.ts";

export function hotkeyConfigure(
  settings: Pick<Settings, "hotkey" | "toggleHotkey" | "transforms">,
  hubFocused: boolean,
): Extract<HelperCommand, { type: "hotkey.configure" }> {
  return {
    type: "hotkey.configure",
    key: settings.hotkey,
    toggleKey: settings.toggleHotkey,
    transforms: hubFocused ? [] : registeredShortcuts(settings.transforms),
  };
}

import type { Settings } from "../shared/api.ts";
import { registeredShortcuts } from "../shared/transforms.ts";
import type { HelperCommand } from "./protocol.ts";

/**
 * The one builder of `hotkey.configure`, so launch and a settings change cannot disagree. While a
 * Voice window is focused no transform shortcut is registered: the picker can record Option+1 and
 * a transform never acts on Voice's own fields.
 */
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

import type { MenuItemConstructorOptions } from "electron";

import type { Permissions } from "../shared/api.ts";

/** The permissions dictation cannot work without. */
export type DictationPermission = "accessibility" | "microphone";

/**
 * The one thing the tray warns about. When several apply, the most urgent wins: a later
 * `helperFailed` goes before `permissionMissing`, since no grant helps while the helper is down.
 */
export type TrayStatus =
  | { kind: "ok" }
  | { kind: "permissionMissing"; missing: readonly DictationPermission[] };

// Accessibility first: without it the shortcut never fires, so a missing mic never shows.
const DICTATION_PERMISSIONS: readonly DictationPermission[] = ["accessibility", "microphone"];

const ALLOW_LABEL: Record<DictationPermission, string> = {
  accessibility: "Shortcut off: allow Accessibility…",
  microphone: "Microphone off: allow access…",
};

export function trayStatus(permissions: Permissions): TrayStatus {
  const missing = DICTATION_PERMISSIONS.filter((kind) => permissions[kind] !== "granted");
  return missing.length === 0 ? { kind: "ok" } : { kind: "permissionMissing", missing };
}

/** The items that open the tray menu while something needs the user, then a separator. */
export function trayStatusItems(
  status: TrayStatus,
  allow: (kind: DictationPermission) => void,
): MenuItemConstructorOptions[] {
  switch (status.kind) {
    case "ok":
      return [];
    case "permissionMissing":
      return [
        ...status.missing.map((kind) => ({
          id: `allow-${kind}`,
          label: ALLOW_LABEL[kind],
          click: () => allow(kind),
        })),
        { type: "separator" },
      ];
  }
}

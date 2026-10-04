import { Menu, type MenuItemConstructorOptions } from "electron";

import type { ZoomStep } from "../shared/zoom.ts";

// The zoom roles would zoom whichever page has focus, for this launch only.
export function createApplicationMenu(zoom: (step: ZoomStep) => void): Menu {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        {
          id: "zoom-reset",
          label: "Actual Size",
          accelerator: "CmdOrCtrl+0",
          click: () => zoom("reset"),
        },
        { id: "zoom-in", label: "Zoom In", accelerator: "CmdOrCtrl+=", click: () => zoom("in") },
        // Cmd+Shift+= types "+" on most layouts, which "=" does not match.
        {
          id: "zoom-in-plus",
          label: "Zoom In",
          accelerator: "CmdOrCtrl+Plus",
          visible: false,
          click: () => zoom("in"),
        },
        { id: "zoom-out", label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => zoom("out") },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}

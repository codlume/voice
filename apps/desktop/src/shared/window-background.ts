// A window paints this before the renderer's first frame, so it must match what the page draws
// first. BrowserWindow rejects oklch, so these repeat the renderer tokens as hex; the test checks
// them against tokens.stylex.ts.
export const windowBackground = {
  // color.sidebar, behind the hub's sidebar and titlebar.
  hub: { light: "#fafafa", dark: "#000000" },
  // color.background, behind the notepad.
  notepad: { light: "#fcfcfc", dark: "#000000" },
} as const;

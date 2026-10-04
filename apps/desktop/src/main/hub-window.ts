const defaultSize = { width: 1350, height: 850 };
// Keeps the window clear of the screen edges on displays smaller than the default.
const workAreaMargin = 20;

export function hubWindowSize(workArea: Pick<Electron.Rectangle, "width" | "height">): {
  width: number;
  height: number;
} {
  return {
    width: Math.min(defaultSize.width, workArea.width - workAreaMargin),
    height: Math.min(defaultSize.height, workArea.height - workAreaMargin),
  };
}

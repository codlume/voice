const defaultSize = { width: 1350, height: 850 };
const minimumSize = { width: 720, height: 480 };
// Keeps the window clear of the screen edges on displays smaller than the default.
const workAreaMargin = 20;

export function hubWindowSize(workArea: Electron.Size) {
  const fit = (axis: "width" | "height") =>
    Math.max(minimumSize[axis], Math.min(defaultSize[axis], workArea[axis] - workAreaMargin));
  return {
    width: fit("width"),
    height: fit("height"),
    minWidth: minimumSize.width,
    minHeight: minimumSize.height,
  };
}

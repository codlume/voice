import { zoomFactor } from "../shared/zoom.ts";

const defaultSize = { width: 1350, height: 850 };
const minimumPage = { width: 720, height: 480 };
const workAreaMargin = 20;

export function hubMinimumSize(zoomLevel: number) {
  const factor = zoomFactor(zoomLevel);
  return {
    width: Math.round(minimumPage.width * factor),
    height: Math.round(minimumPage.height * factor),
  };
}

export function hubWindowSize(workArea: Electron.Size, zoomLevel: number) {
  const minimum = hubMinimumSize(zoomLevel);
  const fit = (axis: "width" | "height") =>
    Math.max(minimum[axis], Math.min(defaultSize[axis], workArea[axis] - workAreaMargin));
  return {
    width: fit("width"),
    height: fit("height"),
    minWidth: minimum.width,
    minHeight: minimum.height,
  };
}

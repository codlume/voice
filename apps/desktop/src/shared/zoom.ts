export type ZoomStep = "in" | "out" | "reset";

const ZOOM_STEP = 0.5;
const MIN_ZOOM_LEVEL = -2;
const MAX_ZOOM_LEVEL = 2;

export function parseZoomLevel(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const snapped = Math.round(value / ZOOM_STEP) * ZOOM_STEP;
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, snapped)) || 0;
}

export function nextZoomLevel(current: number, step: ZoomStep): number {
  if (step === "reset") return 0;
  return parseZoomLevel(current + (step === "in" ? ZOOM_STEP : -ZOOM_STEP));
}

export const zoomFactor = (level: number) => 1.2 ** level;

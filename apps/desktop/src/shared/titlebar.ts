import { zoomFactor } from "./zoom.ts";

// The native traffic lights do not scale with zoom.
export const TITLEBAR_HEIGHT = 48;
export const TRAFFIC_LIGHTS = { x: 16, y: 18 };
const TRAFFIC_LIGHTS_INSET = 92;

export function trafficLightPosition(zoomLevel: number) {
  const grown = ((zoomFactor(zoomLevel) - 1) * TITLEBAR_HEIGHT) / 2;
  return { x: TRAFFIC_LIGHTS.x, y: Math.round(TRAFFIC_LIGHTS.y + grown) };
}

export function trafficLightsInset(zoomLevel: number) {
  return TRAFFIC_LIGHTS_INSET / zoomFactor(zoomLevel);
}

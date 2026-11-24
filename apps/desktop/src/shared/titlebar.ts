import { zoomFactor } from "./zoom.ts";

// The native traffic lights do not scale with zoom.
// A 52pt topbar with the traffic lights centred in it, adapted under MIT (see THIRD_PARTY_NOTICES.md).
export const TITLEBAR_HEIGHT = 52;
const TRAFFIC_LIGHTS = { x: 16, y: 19 };
const TRAFFIC_LIGHTS_INSET = 90;

export function trafficLightPosition(zoomLevel: number) {
  const grown = ((zoomFactor(zoomLevel) - 1) * TITLEBAR_HEIGHT) / 2;
  return { x: TRAFFIC_LIGHTS.x, y: Math.round(TRAFFIC_LIGHTS.y + grown) };
}

export function trafficLightsInset(zoomLevel: number) {
  return TRAFFIC_LIGHTS_INSET / zoomFactor(zoomLevel);
}

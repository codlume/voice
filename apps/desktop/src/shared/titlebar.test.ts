import { expect, test } from "vite-plus/test";

import { trafficLightPosition, trafficLightsInset } from "./titlebar.ts";
import { zoomFactor } from "./zoom.ts";

const BUTTON_HEIGHT = 12;

test.each([-2, -0.5, 0, 1, 2])(
  "keeps the traffic lights centred in the row at level %j",
  (level) => {
    const rowHeight = 48 * zoomFactor(level);
    const { x, y } = trafficLightPosition(level);
    expect(x).toBe(16);
    expect(Math.abs(y + BUTTON_HEIGHT / 2 - rowHeight / 2)).toBeLessThanOrEqual(0.5);
  },
);

test.each([-2, 0, 2])("keeps the traffic lights' inset at 92 pt on screen at level %j", (level) => {
  expect(trafficLightsInset(level) * zoomFactor(level)).toBeCloseTo(92);
});

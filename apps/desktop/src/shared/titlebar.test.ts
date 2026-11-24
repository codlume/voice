import { expect, test } from "vite-plus/test";

import { TITLEBAR_HEIGHT, trafficLightPosition, trafficLightsInset } from "./titlebar.ts";
import { zoomFactor } from "./zoom.ts";

// A standard window button's frame is 14pt tall around its 12pt circle.
const BUTTON_HEIGHT = 14;

test.each([-2, -0.5, 0, 1, 2])(
  "keeps the traffic lights centred in the row at level %j",
  (level) => {
    const rowHeight = TITLEBAR_HEIGHT * zoomFactor(level);
    const { x, y } = trafficLightPosition(level);
    expect(x).toBe(16);
    expect(Math.abs(y + BUTTON_HEIGHT / 2 - rowHeight / 2)).toBeLessThanOrEqual(0.5);
  },
);

test.each([-2, 0, 2])("keeps the traffic lights' inset at 90 pt on screen at level %j", (level) => {
  expect(trafficLightsInset(level) * zoomFactor(level)).toBeCloseTo(90);
});

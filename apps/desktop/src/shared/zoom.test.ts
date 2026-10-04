import { describe, expect, test } from "vite-plus/test";

import { nextZoomLevel, parseZoomLevel, zoomFactor } from "./zoom.ts";

describe("nextZoomLevel", () => {
  test("steps by half a level", () => {
    expect(nextZoomLevel(0, "in")).toBe(0.5);
    expect(nextZoomLevel(0.5, "out")).toBe(0);
    expect(nextZoomLevel(0, "out")).toBe(-0.5);
  });

  test("stops at about 144% and 69%", () => {
    expect(zoomFactor(nextZoomLevel(2, "in"))).toBeCloseTo(1.44);
    expect(zoomFactor(nextZoomLevel(-2, "out"))).toBeCloseTo(0.694, 3);
  });

  test.each([-2, -0.5, 0, 1.5, 2])("reset from %j returns to 100%", (level) => {
    expect(nextZoomLevel(level, "reset")).toBe(0);
  });
});

describe("parseZoomLevel", () => {
  test.each([
    [1.5, 1.5],
    [1.2, 1],
    [1.3, 1.5],
    [-0.7, -0.5],
    [-0.2, 0],
    [9, 2],
    [-9, -2],
  ])("snaps %j to the half-level grid inside the bounds as %j", (raw, level) => {
    expect(parseZoomLevel(raw)).toBe(level);
  });

  test.each([undefined, null, "1", true, {}, [], Number.NaN, Infinity, -Infinity])(
    "falls back to 100%% for %j",
    (raw) => {
      expect(parseZoomLevel(raw)).toBe(0);
    },
  );
});

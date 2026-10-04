import { describe, expect, test } from "vite-plus/test";

import { hubWindowSize } from "./hub-window.ts";
import { nextZoomLevel } from "../shared/zoom.ts";

const minimum = { minWidth: 720, minHeight: 480 };

describe("hubWindowSize", () => {
  test("opens at the default size on a display with room for it", () => {
    expect(hubWindowSize({ width: 2560, height: 1415 }, 0)).toEqual({
      width: 1350,
      height: 850,
      ...minimum,
    });
  });

  test("leaves a margin on both axes of a small display", () => {
    expect(hubWindowSize({ width: 1280, height: 775 }, 0)).toEqual({
      width: 1260,
      height: 755,
      ...minimum,
    });
  });

  test("clamps only the axis that does not fit", () => {
    expect(hubWindowSize({ width: 1920, height: 800 }, 0)).toEqual({
      width: 1350,
      height: 780,
      ...minimum,
    });
  });

  test("never opens below the minimum size", () => {
    expect(hubWindowSize({ width: 400, height: 300 }, 0)).toEqual({
      width: 720,
      height: 480,
      ...minimum,
    });
  });

  test("scales the minimum with zoom, so the page keeps its 720x480 CSS px", () => {
    expect(hubWindowSize({ width: 2560, height: 1415 }, -2)).toMatchObject({
      minWidth: 500,
      minHeight: 333,
    });
    expect(hubWindowSize({ width: 2560, height: 1415 }, 2)).toMatchObject({
      minWidth: 1037,
      minHeight: 691,
    });
  });

  test("still fits a 1280x800 display at the highest zoom", () => {
    const highest = nextZoomLevel(99, "in");
    const { width, height, minWidth, minHeight } = hubWindowSize(
      { width: 1280, height: 775 },
      highest,
    );
    expect(minWidth).toBeLessThanOrEqual(width);
    expect(minHeight).toBeLessThanOrEqual(height);
    expect(width).toBeLessThanOrEqual(1280);
    expect(height).toBeLessThanOrEqual(775);
  });
});

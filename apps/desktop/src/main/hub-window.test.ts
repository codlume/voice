import { describe, expect, test } from "vite-plus/test";

import { hubWindowSize } from "./hub-window.ts";

const minimum = { minWidth: 720, minHeight: 480 };

describe("hubWindowSize", () => {
  test("opens at the default size on a display with room for it", () => {
    expect(hubWindowSize({ width: 2560, height: 1415 })).toEqual({
      width: 1350,
      height: 850,
      ...minimum,
    });
  });

  test("leaves a margin on both axes of a small display", () => {
    expect(hubWindowSize({ width: 1280, height: 775 })).toEqual({
      width: 1260,
      height: 755,
      ...minimum,
    });
  });

  test("clamps only the axis that does not fit", () => {
    expect(hubWindowSize({ width: 1920, height: 800 })).toEqual({
      width: 1350,
      height: 780,
      ...minimum,
    });
  });

  test("never opens below the minimum size", () => {
    expect(hubWindowSize({ width: 400, height: 300 })).toEqual({
      width: 720,
      height: 480,
      ...minimum,
    });
  });
});

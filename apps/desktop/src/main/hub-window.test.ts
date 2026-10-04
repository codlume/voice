import { describe, expect, test } from "vite-plus/test";

import { hubWindowSize } from "./hub-window.ts";

describe("hubWindowSize", () => {
  test("opens at the default size on a display with room for it", () => {
    expect(hubWindowSize({ width: 2560, height: 1415 })).toEqual({ width: 1350, height: 850 });
  });

  test("leaves a margin on both axes of a small display", () => {
    expect(hubWindowSize({ width: 1280, height: 775 })).toEqual({ width: 1260, height: 755 });
  });

  test("clamps only the axis that does not fit", () => {
    expect(hubWindowSize({ width: 1920, height: 800 })).toEqual({ width: 1350, height: 780 });
  });
});

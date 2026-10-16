import { useLayoutEffect } from "react";

import type { AnimationSpeed } from "../shared/api.ts";

const MOTION_SCALE: Record<AnimationSpeed, number> = { off: 0, fast: 0.5, normal: 1, slow: 2 };

export function useMotionScale(speed: AnimationSpeed) {
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--motion-scale", String(MOTION_SCALE[speed]));
  }, [speed]);
}

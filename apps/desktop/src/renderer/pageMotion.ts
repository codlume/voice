import * as stylex from "@stylexjs/stylex";

const reducedMotion = "@media (prefers-reduced-motion: reduce)";
const easing = "cubic-bezier(0.2, 0, 0, 1)";

const rise = stylex.keyframes({ from: { opacity: 0, transform: "translateY(8px)" } });
const slideForward = stylex.keyframes({ from: { opacity: 0, transform: "translateX(16px)" } });
const slideBack = stylex.keyframes({ from: { opacity: 0, transform: "translateX(-16px)" } });

// Durations read --page-animation, which HubShell sets from the Page animations setting.
export const pageMotion = stylex.create({
  rise: {
    animationName: { default: rise, [reducedMotion]: "none" },
    animationDuration: "var(--page-animation)",
    animationTimingFunction: easing,
  },
  forward: {
    animationName: { default: slideForward, [reducedMotion]: "none" },
    animationDuration: "var(--page-animation)",
    animationTimingFunction: easing,
  },
  back: {
    animationName: { default: slideBack, [reducedMotion]: "none" },
    animationDuration: "var(--page-animation)",
    animationTimingFunction: easing,
  },
});

export type PageMotion = keyof typeof pageMotion;

import * as stylex from "@stylexjs/stylex";

const reducedMotion = "@media (prefers-reduced-motion: reduce)";
const easing = "cubic-bezier(0.2, 0, 0, 1)";

const rise = stylex.keyframes({ from: { opacity: 0, transform: "translateY(8px)" } });

// Durations read --page-animation, which HubShell sets from the Page animations setting.
export const pageMotion = stylex.create({
  rise: {
    animationName: { default: rise, [reducedMotion]: "none" },
    animationDuration: "var(--page-animation)",
    animationTimingFunction: easing,
  },
});

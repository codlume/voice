import * as stylex from "@stylexjs/stylex";

export const color = stylex.defineVars({
  page: "#f6f3ee",
  ink: "#1f1d1a",
  muted: "#77716a",
});

export const radius = stylex.defineVars({
  round: "999px",
});

export const space = stylex.defineVars({
  sm: "8px",
  md: "12px",
  lg: "20px",
  xl: "32px",
  xxl: "48px",
});

export const font = stylex.defineVars({
  sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
  serif: 'ui-serif, "New York", "Iowan Old Style", Charter, Georgia, serif',
});

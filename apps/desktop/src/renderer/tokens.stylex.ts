import * as stylex from "@stylexjs/stylex";

export const color = stylex.defineVars({
  page: "#f6f3ee",
  sidebar: "#efebe4",
  panel: "#fffdfa",
  ink: "#1f1d1a",
  muted: "#77716a",
  faint: "#a39d94",
  border: "#e6e0d7",
  hover: "rgba(31, 29, 26, 0.05)",
  selected: "rgba(31, 29, 26, 0.08)",
  ready: "#3f7a52",
  failed: "#b2432f",
  track: "#e8e3db",
  pill: "#0b0b0c",
  pillLine: "rgba(255, 255, 255, 0.14)",
});

export const radius = stylex.defineVars({
  small: "6px",
  medium: "10px",
  large: "14px",
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
